// Browser: the app framed by the Radius shell, end to end with the real web bundle. A stand-in shell page on another
// site (`localhost` against the app's `127.0.0.1`) frames the app as Radius does and speaks the shell's side of the
// `pi-shell` channel (src/web/shell-bridge.ts): it answers `ready` with its base and mirrors each reported address
// into its own URL with replaceState. The app is told it is relayed, framed by that origin, as the Radius plugin's
// request resolver would. The shell's real side is Radius's (its pi-shell e2e test frames a stand-in app instead).
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Familiar } from "../../plugins/familiar/contract.ts";
import { Models } from "../../plugins/models/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { defineFacet } from "../../src/runtime/chord.ts";
import { RequestResolvers } from "../../src/runtime/server.ts";
import { Browser, browserTests } from "./browser.ts";
import { type Fixture, holdIn, poll, startFixture, until } from "./helpers.ts";

const BRAIN = "/pi/acme/11111111-0000-4000-8000-000000000000";

/** The stand-in shell: frames `app`, keeps the channel's messages in `window.shellLog`. */
const shellPage = (app: string) => `<!doctype html><title>Shell</title>
<iframe src="${app}/" style="width:1200px;height:800px;border:0"></iframe>
<script>
const frame = document.querySelector("iframe");
const appOrigin = ${JSON.stringify(app)};
window.shellLog = [];
addEventListener("message", (event) => {
	if (event.source !== frame.contentWindow || event.origin !== appOrigin || event.data?.channel !== "pi-shell") return;
	shellLog.push(event.data);
	if (event.data.type === "ready")
		frame.contentWindow.postMessage({ channel: "pi-shell", type: "hello", version: 1, base: location.origin + ${JSON.stringify(BRAIN)} }, appOrigin);
	if (event.data.type === "location") history.replaceState(null, "", ${JSON.stringify(BRAIN)} + (event.data.path === "/" ? "" : event.data.path));
});
</script>`;

describe("framed by the Radius shell", { skip: !browserTests }, () => {
	let fixture: Fixture;
	let browser: Browser;
	let shell: Server;
	let shellOrigin: string;
	let appOrigin: string;
	before(async () => {
		shell = createServer((_request, response) => {
			response.writeHead(200, { "Content-Type": "text/html" });
			response.end(shellPage(appOrigin));
		});
		await new Promise<void>((resolve) => shell.listen(0, "127.0.0.1", resolve));
		shellOrigin = `http://localhost:${(shell.address() as AddressInfo).port}`;
		let port = 0;
		// As the Radius plugin marks relayed requests: the owner, from the app's origin, framed by the shell. Only the
		// browser's requests; the test's own clients sign in locally as usual.
		const relayed = defineFacet((_host, self) =>
			self.contribute(RequestResolvers, {
				"test-shell": (request) =>
					request.headers["user-agent"]?.includes("Chrome")
						? {
								principal: { kind: "owner", access: "relay" },
								origin: {
									origin: `http://127.0.0.1:${port}`,
									remote: true,
									port,
									relayShellOrigin: shellOrigin,
								},
							}
						: undefined,
			}),
		);
		fixture = await startFixture({ web: true, facets: [{ name: "test-shell", facet: relayed }] });
		port = fixture.server.port;
		appOrigin = `http://127.0.0.1:${port}`;
		const owner = fixture.browser();
		await owner
			.hold(Models, {}, BACKGROUND_CONTEXT)
			.setDefault({ provider: "faux", modelId: "faux-1", thinkingLevel: "off" }, BACKGROUND_CONTEXT);
		browser = await Browser.start();
	});
	after(async () => {
		await browser?.close();
		await fixture?.close();
		await new Promise<void>((resolve) => shell?.close(() => resolve()));
	});

	const log = () => browser.evaluate<{ type: string; path?: string }[]>("shellLog");
	const inApp = <T>(expression: string) => browser.evaluateInFrame<T>(appOrigin, expression);

	it("mirrors the app's address into the shell's URL, links open the shell, Back moves the app", async () => {
		const sessions = await holdIn(fixture.browser(), Sessions, {}, "owner");
		const session = await sessions.create({ cwd: fixture.workspace, title: "Framed" }, BACKGROUND_CONTEXT);
		await browser.open(`${shellOrigin}/`);
		await browser.wait(`shellLog.some((message) => message.type === "ready")`);
		await browser.wait(`location.pathname === ${JSON.stringify(BRAIN)}`);

		// Links carry the shell's URL once the shell said its base.
		const row = `document.querySelector('.session-main[href$=${JSON.stringify(`/s/${session.id}`)}]')`;
		await poll(() => inApp<boolean>(`Boolean(${row})`), 30_000, "the session's row");
		assert.equal(await inApp<string>(`${row}.href`), `${shellOrigin}${BRAIN}/s/${session.id}`);

		// Home is an asynchronous Familiar session, not a stable `/` screen.
		// Wait for its actual destination before taking the history baseline;
		// otherwise a late home replace races with our session-row click.
		const familiar = await holdIn(fixture.browser(), Familiar, {}, "owner");
		const familiarId = await until(familiar.session, (id) => typeof id === "string");
		familiar.release();
		await poll(
			() => inApp<boolean>(`location.pathname.startsWith(${JSON.stringify(`/s/${familiarId}`)})`),
			30_000,
			"the Familiar home route",
		);
		const start = await inApp<string>("location.pathname");
		const shellUrl = (path: string) => (path === "/" ? BRAIN : `${BRAIN}${path}`);
		await browser.wait(`location.pathname === ${JSON.stringify(shellUrl(start))}`);

		// A plain click acts in the app; the shell's URL follows, one history entry for the step.
		const entries = await browser.evaluate<number>("history.length");
		// A synthetic Element.click() gives Chrome no user activation. Chrome may then
		// skip its history entry when Back is pressed. Send a real pointer click.
		const target = await inApp<{ x: number; y: number }>(
			`(() => { const r=${row}.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`,
		);
		const frame = await browser.evaluate<{ x: number; y: number }>(
			"(() => { const r=document.querySelector('iframe').getBoundingClientRect(); return {x:r.left,y:r.top}; })()",
		);
		await browser.clickPoint(frame.x + target.x, frame.y + target.y);
		await browser.wait(`location.pathname === ${JSON.stringify(`${BRAIN}/s/${session.id}`)}`);
		assert.equal(await browser.evaluate<number>("history.length"), entries + 1);

		// The browser's Back returns the app to where it was, and the shell's URL with it; Forward again.
		// The app owns the navigation entry in the child frame; ask that frame
		// to traverse its history, then verify the shell mirrors the resulting URL.
		await inApp("history.back()");
		try {
			await browser.wait(`location.pathname === ${JSON.stringify(shellUrl(start))}`);
		} catch (error) {
			// Preserve browser/child frame history diagnostics when a history
			// intervention or a frame transition prevents the expected Back.
			const shellState = await browser.evaluate<unknown>(
				"({path:location.pathname, length:history.length, state:history.state, messages:shellLog})",
			);
			const frameState = await inApp<unknown>(
				"({path:location.pathname, length:history.length, state:history.state})",
			).catch((cause) => ({ error: String(cause) }));
			throw new Error(`Shell Back did not restore ${start}: ${JSON.stringify({ shellState, frameState })}`, {
				cause: error,
			});
		}
		assert.equal(await inApp<string>("location.pathname"), start);
		await inApp("history.forward()");
		await browser.wait(`location.pathname === ${JSON.stringify(`${BRAIN}/s/${session.id}`)}`);
		// Only addresses went to the shell, and only to its origin (else the stand-in would not have seen them).
		assert.ok((await log()).every((message) => message.type === "ready" || message.type === "location"));
	});
});
