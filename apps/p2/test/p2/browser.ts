import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { buildBrowserScript } from "../../src/hosts/bundles.ts";
import { poll } from "./helpers.ts";

export const chromium =
	process.env.CHROMIUM_BIN ?? (process.env.PREFIX ? `${process.env.PREFIX}/lib/chromium/chrome` : "/usr/bin/chromium");
/**
 * Whether the Chromium UI tests run. Off on Android unless `P2_BROWSER_TESTS=1`: Chromium's processes plus the test's p2
 * server and workers exceed Android's limit of 32 child processes, and its phantom process killer then kills processes
 * (also the p2 the tests run under). Elsewhere on where Chromium is installed; `P2_BROWSER_TESTS=0` turns them off.
 */
export const browserTests =
	process.env.P2_BROWSER_TESTS === "1" ||
	(process.env.P2_BROWSER_TESTS !== "0" && process.platform !== "android" && existsSync(chromium));
export class Browser {
	readonly process: ChildProcess;
	readonly profile: string;
	readonly socket: WebSocket;
	private id = 0;
	private loaded = new Set<string>();
	private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	private constructor(process: ChildProcess, profile: string, socket: WebSocket) {
		this.process = process;
		this.profile = profile;
		this.socket = socket;
		socket.on("message", (raw) => {
			const message = JSON.parse(raw.toString()) as {
				id?: number;
				result?: unknown;
				error?: { message: string };
				method?: string;
				params?: { name?: string; loaderId?: string };
			};
			if (
				message.method === "Page.lifecycleEvent" &&
				message.params?.name === "DOMContentLoaded" &&
				message.params.loaderId
			)
				this.loaded.add(message.params.loaderId);
			if (!message.id) return;
			const request = this.pending.get(message.id);
			this.pending.delete(message.id);
			if (message.error) request?.reject(new Error(message.error.message));
			else request?.resolve(message.result);
		});
	}
	static async start(flags: string[] = []): Promise<Browser> {
		// A heavily loaded CI runner may fail to bring up the first Chromium process.
		// Retry startup, but keep the test failing with Chromium's diagnostics if neither attempt works.
		let lastError: unknown;
		for (let attempt = 0; attempt < 2; attempt++) {
			const profile = mkdtempSync(join(tmpdir(), "p2-browser-"));
			const process = spawn(
				chromium,
				[
					...(globalThis.process.env.PREFIX ? [`--browser-subprocess-path=${chromium}`] : []),
					"--headless=new",
					"--no-sandbox",
					"--no-zygote",
					"--disable-gpu",
					"--disable-dev-shm-usage",
					"--remote-debugging-address=127.0.0.1",
					"--remote-debugging-port=0",
					`--user-data-dir=${profile}`,
					...flags,
					"about:blank",
				],
				{ stdio: ["ignore", "ignore", "pipe"] },
			);
			let diagnostics = "";
			process.stderr?.on("data", (chunk: Buffer) => {
				diagnostics = (diagnostics + chunk.toString()).slice(-4000);
			});
			process.on("error", (error) => {
				diagnostics = `${diagnostics}\n${error.message}`;
			});
			let socket: WebSocket | undefined;
			try {
				const activePort = join(profile, "DevToolsActivePort");
				await poll(
					() => existsSync(activePort) || process.exitCode !== null || process.signalCode !== null,
					30_000,
					"Chromium debugging port",
				);
				if (!existsSync(activePort)) throw new Error("Chromium exited before opening its debugging port");
				const port = readFileSync(activePort, "utf8").split("\n")[0];
				const targets = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as {
					type: string;
					webSocketDebuggerUrl: string;
				}[];
				const page = targets.find((target) => target.type === "page") ?? targets[0];
				if (!page) throw new Error("Chromium has no DevTools targets");
				socket = new WebSocket(page.webSocketDebuggerUrl);
				await new Promise<void>((resolve, reject) => {
					socket!.once("open", resolve);
					socket!.once("error", reject);
				});
				const browser = new Browser(process, profile, socket);
				await browser.call("Page.enable");
				await browser.call("Page.setLifecycleEventsEnabled", { enabled: true });
				return browser;
			} catch (error) {
				lastError = new Error(
					`Chromium startup attempt ${attempt + 1} failed: ${error instanceof Error ? error.message : String(error)}\n${diagnostics}`,
				);
				socket?.close();
				process.kill("SIGKILL");
				rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
			}
		}
		throw lastError;
	}

	/** Sends a DevTools command to the page, or to an attached target's flat session (`evaluateInFrame`). */
	call(method: string, params: object = {}, sessionId?: string): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const id = ++this.id;
			this.pending.set(id, {
				resolve,
				reject: (error) => reject(new Error(`${method}: ${error.message}`, { cause: error })),
			});
			this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
		});
	}
	/**
	 * Evaluates `expression` in the out-of-process frame whose URL contains `url`: an artifact preview has an opaque
	 * origin, so the page itself cannot reach into it.
	 */
	async evaluateInFrame<T>(url: string, expression: string): Promise<T> {
		const { targetInfos } = (await this.call("Target.getTargets")) as {
			targetInfos: { targetId: string; type: string; url: string }[];
		};
		const target = targetInfos.find((info) => info.type === "iframe" && info.url.includes(url));
		if (!target) throw new Error(`No frame target for ${url}`);
		const { sessionId } = (await this.call("Target.attachToTarget", {
			targetId: target.targetId,
			flatten: true,
		})) as {
			sessionId: string;
		};
		try {
			const response = (await this.call(
				"Runtime.evaluate",
				{ expression, returnByValue: true, awaitPromise: true },
				sessionId,
			)) as { result: { value: T }; exceptionDetails?: unknown };
			if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
			return response.result.value;
		} finally {
			await this.call("Target.detachFromTarget", { sessionId }).catch(() => {});
		}
	}
	async evaluate<T>(expression: string): Promise<T> {
		const response = (await this.call("Runtime.evaluate", {
			expression,
			returnByValue: true,
			awaitPromise: true,
		})) as { result: { value: T }; exceptionDetails?: unknown };
		if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
		return response.result.value;
	}
	wait(expression: string): Promise<void> {
		return poll(
			async () => {
				try {
					return await this.evaluate<boolean>(`Boolean(${expression})`);
				} catch (error) {
					// A cross-document redirect can invalidate the current JS context
					// between DevTools evaluation and the result. Poll the next document.
					if (
						error instanceof Error &&
						/Inspected target navigated or closed|Execution context was destroyed|Cannot find context with specified id/.test(
							error.message,
						)
					)
						return false;
					throw error;
				}
			},
			30_000,
			expression,
		);
	}
	/** Gives this profile the local owner's session cookie, as the owner's sign-in link would. */
	async signIn(owner: { readonly port: number; readonly cookie: string }): Promise<void> {
		const [name, value] = owner.cookie.split("=", 2) as [string, string];
		await this.call("Network.setCookie", {
			name,
			value,
			url: `http://127.0.0.1:${owner.port}/`,
			httpOnly: true,
			sameSite: "Lax",
		});
	}
	async metrics(width: number, height: number): Promise<void> {
		await this.call("Emulation.setDeviceMetricsOverride", {
			width,
			height,
			mobile: width < 700,
			deviceScaleFactor: 1,
		});
	}
	async open(url: string): Promise<void> {
		const result = (await this.call("Page.navigate", { url })) as { loaderId?: string; errorText?: string };
		if (result.errorText) throw new Error(result.errorText);
		if (result.loaderId) await poll(() => this.loaded.has(result.loaderId!), 30_000, "new document loaded");
	}
	/**
	 * Runs a browser-only component fixture (`test/fixtures/<name>`) in the open page, compiled like the web bundle
	 * (`buildBrowserScript`) and evaluated through the debugger, which the page's CSP does not restrict. The fixture
	 * renders with its own React; the page's styles apply.
	 */
	async loadFixture(name: string): Promise<void> {
		await this.evaluate(await buildBrowserScript(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url))));
	}
	async click(selector: string): Promise<void> {
		await this.wait(
			`document.querySelector(${JSON.stringify(selector)}) && !document.querySelector(${JSON.stringify(selector)}).disabled`,
		);
		// A test may click an older transcript row outside the viewport. Like a
		// pointer-driven browser, bring it into view before checking hit-testing.
		await this.evaluate(
			`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: "center", inline: "nearest" })`,
		);
		await this.wait(
			`(() => { const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)return false;for(let p=e;p;p=p.parentElement)if(p.getAnimations().some(a=>a.playState==='running'&&a.effect?.getTiming().iterations!==Infinity))return false;const r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return r.width>0&&r.height>0&&e.contains(hit); })()`,
		);
		const point = await this.evaluate<{ x: number; y: number }>(
			`(() => {const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`,
		);
		await this.clickPoint(point.x, point.y);
	}
	/**
	 * Opens the Settings window from the sidebar's gear (a click in the page: on phones the drawer may be closed) and
	 * then its section `label`, and waits for that section's page.
	 */
	async openSettings(label: string): Promise<void> {
		await this.wait(`document.querySelector('.drawer-foot .settings-open')`);
		await this.evaluate(`document.querySelector('.drawer-foot .settings-open').click()`);
		const item = `[...document.querySelectorAll('.settings-nav-item')].find((e) => e.textContent === ${JSON.stringify(label)})`;
		await this.wait(item);
		await this.evaluate(`${item}.click()`);
		await this.wait(`document.querySelector('.settings-pane > .settings-page')`);
	}
	async clickPoint(x: number, y: number): Promise<void> {
		await this.call("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
		await this.call("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
	}
	async close(): Promise<void> {
		await this.call("Browser.close").catch(() => {});
		this.socket.close();
		// Browser.close acknowledges before Chromium (or its Docker wrapper) finishes flushing the profile.
		const exited = () => this.process.exitCode !== null || this.process.signalCode !== null;
		try {
			await poll(exited, 5000, "Chromium shutdown");
		} catch {
			this.process.kill("SIGTERM");
			await poll(exited, 5000, "Chromium termination");
		}
		rmSync(this.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
}
