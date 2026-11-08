// The discord plugin's server facet: the owner's bots (fleet.ts, tokens in `<data>/discord.json`), the links of
// sessions to channels with their cursors, threads and pending replies (persisted), the relay between them (relay.ts),
// and the owner's `Discord` view. Linking moves the session into a sandbox and locks it to the picked resources;
// unlinking lifts the lock.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { nul, obj, opt, str, union } from "@earendil-works/pi-schema";
import {
	type AcceptsTable,
	BACKGROUND_CONTEXT,
	type Ctx,
	defineFacet,
	defineState,
	deriveTyped,
	followNative,
	forbidden,
	isOwner,
	type Ref,
	record,
	SessionLockSchema,
	signalOf,
	sleep,
} from "@p2/app/v1";
import { optionalText, stripJsonComments } from "@p2/app/v1/node";
import { Routes, Server, serverOf } from "@p2/app/v1/server";
import { EnvService } from "../envs/contract.ts";
import { isSandbox } from "../envs/schema.ts";
import { Catalog, SessionLocks, SessionMoves } from "../sessions/contract.ts";
import { StatusStore } from "../status/contract.ts";
import { BindingSchema, Discord, DiscordIngress, DiscordStore, PendingSchema, WakeSchema } from "./contract.ts";
import { FIRST_BOT, Fleet } from "./fleet.ts";
import { LinkMutationQueue } from "./link-mutations.ts";
import { removeSessionBinding, resumeLinkRepairs, type LinkRepairState } from "./link-recovery.ts";
import { commandOf, Relay, type RelayState, type SessionPort } from "./relay.ts";
import { DiscordScheduler } from "./scheduler.ts";

const LinkRepairSchema = obj({
	kind: str(),
	session: str(),
	lock: union([SessionLockSchema, nul()]),
	expectedLock: opt(union([SessionLockSchema, nul()])),
	proposedLock: opt(union([SessionLockSchema, nul()])),
	wake: opt(WakeSchema),
});

const State = defineState("p2.discord-bindings", {
	schema: obj({ bindings: record(BindingSchema), pending: record(PendingSchema), repairs: record(LinkRepairSchema) }),
	// 3: persisted intent journal for interruption-safe lock/link operations.
	version: 3,
	initial: () => ({ bindings: {}, pending: {}, repairs: {} }),
	migrate: (old, from) => {
		if (from === 2) return { ...(old as Record<string, unknown>), repairs: {} } as never;
		if (from !== 1) throw new Error(`Unknown p2.discord-bindings version ${from}`);
		const value = old as { bindings: Record<string, object>; pending: Record<string, object> };
		const named = (entries: Record<string, object>) =>
			Object.fromEntries(Object.entries(entries).map(([key, entry]) => [key, { ...entry, botId: FIRST_BOT }]));
		return { bindings: named(value.bindings), pending: named(value.pending), repairs: {} } as never;
	},
	persist: true,
	checkpointWhen: () => true,
});

/**
 * How often "typing" is refreshed while a delivery is under way or a reply pending (Discord shows it about 10 s), and
 * every how many of those pending turns are checked anyway.
 */
const TYPING_MS = 8_000;
const CHECK_EVERY = 2;

export default defineFacet((host) => {
	host.serve(DiscordStore, (_params, self) => {
		const server = self.get(Server, {});
		const catalog = self.get(Catalog, {});
		const envs = self.get(EnvService, {});
		const locks = self.get(SessionLocks, {});
		const moves = self.get(SessionMoves, {});
		const statuses = self.get(StatusStore, {});
		const state = self.state(State);
		const dataDir = () => server.info.value.dataDir;
		const fleet = self.open(
			() => Fleet.open(dataDir()),
			(opened) => opened.close(),
		);
		/** The context of the store's live loop: replies, deliveries and state changes run under it. */
		let live: Ctx | undefined;
		const during = (): Ctx => {
			if (!live) throw new Error("The Discord store is not live");
			return live;
		};
		const usable = async (session: string): Promise<string | undefined> => {
			const row = catalog.sessions.value.find((entry) => entry.id === session);
			if (!row) return "its p2 session is gone.";
			if (row.archivedAt !== null) return "its p2 session is archived.";
			if (!row.env || !isSandbox(envs.configs.value, row.env)) return "its p2 session does not work in a sandbox.";
			return undefined;
		};
		const natives = serverOf(self);
		/** One call of session `session`'s worker (started if needed) as the server, in a scope of its own. */
		const ingress = <T>(
			session: string,
			call: (worker: Ref<typeof DiscordIngress>, ctx: Ctx) => Promise<T>,
		): Promise<T> =>
			// A root scope releases the worker's reference when the call ends; the live routine's would keep them all.
			natives().root(async (ctx) => call(await ctx.get(DiscordIngress, { session }), ctx), BACKGROUND_CONTEXT);
		const sessions: SessionPort = {
			usable,
			lock: (session) => locks.locks.value[session] ?? null,
			deliver: (session, input) => ingress(session, (worker, ctx) => worker.deliver(input, ctx)),
			turn: (session, submissionId) => ingress(session, (worker, ctx) => worker.turn({ submissionId }, ctx)),
			thread: (session, name, before) => ingress(session, (worker, ctx) => worker.thread({ name, before }, ctx)),
			command: (session, input) => ingress(session, (worker, ctx) => worker.command(input, ctx)),
			read: (session, id, offset, length) =>
				ingress(session, (worker, ctx) => worker.read({ id, offset, length }, ctx)),
		};
		// Owner link mutations may await remote Discord calls; serialize their entire
		// transaction, including unlink, to preserve the one-session/one-channel invariant.
		const linkMutations = new LinkMutationQueue();
		const reconcile = (ctx: Ctx): Promise<void> => resumeLinkRepairs({
			value: () => state.value as unknown as LinkRepairState,
			change: (update) => state.change((draft) => update(draft as unknown as LinkRepairState), ctx),
		}, async (session, lock, expected) => {
			if (expected !== undefined) {
				const { applied } = await locks.compareAndSet({ session, previous: expected, lock }, ctx);
				return applied;
			}
			await locks.set({ session, lock }, ctx);
			return true;
		}, {
			beforeUnlock: (session) => relay.waitForSession(session),
			notifyUnlinked: async (session) => {
				const row = catalog.sessions.value.find((entry) => entry.id === session);
				if (row && row.archivedAt === null)
					await ingress(session, (worker, scope) => worker.unlinked(scope));
			},
		});
		const linkExclusive = <T>(ctx: Ctx, action: () => Promise<T>): Promise<T> => linkMutations.run(async () => {
			// No new mutation can bypass an unfinished durable repair.
			if (Object.keys(state.value.repairs).length) await reconcile(ctx);
			return action();
		});
		const relay = new Relay((bot) => fleet.value.connected(bot), sessions, {
			// The state's drafts are the same JSON as the relay's plain records.
			value: () => state.value as RelayState,
			change: (update) => state.change((draft) => update(draft as RelayState), during()),
		}, (bot) => fleet.value.requestCatchUp(bot));
		self.onLive(async (ctx) => {
			live = ctx;
			// Repair interrupted link operations before consuming events or enabling new links.
			while (Object.keys(state.value.repairs).length) {
				try {
					await linkMutations.run(() => reconcile(ctx));
				} catch (error) {
					console.error("p2 discord: link repair failed; retrying without opening relay:", errorText(error));
					await sleep(10_000, ctx);
				}
			}
			const scheduler = new DiscordScheduler(
				(bot) => fleet.value.requestCatchUp(bot),
				(error) => console.error("p2 discord:", errorText(error)),
			);
			try {
				// The scheduler preserves each channel's delivery order but does not let
				// a slow channel block another channel, or a stop/status command.
				for (;;) {
					const received = await fleet.value.next(signalOf(ctx));
					if (!received) return;
					const { bot, event } = received;
					const id = fleet.value.connected(bot)?.botId;
					scheduler.enqueue({
						bot,
						catchUp: event.kind === "ready",
						key: event.kind === "message" ? `${bot}:channel:${event.message.channelId}` : `${bot}:catch-up`,
						priority: event.kind === "message" && event.message.mentionsBot &&
							id !== undefined && commandOf(event.message.text, id) !== undefined,
						onRejected: event.kind === "message" ? async () => {
							await fleet.value.connected(bot)?.reply(event.message.channelId, event.message.id,
								"Pi control backlog is full; your command was not executed. Please retry.");
						} : undefined,
						run: () => event.kind === "message" ? relay.onMessage(bot, event.message) : relay.catchUp(bot),
					});
				}
			} finally {
				scheduler.stop();
				live = undefined;
			}
		});
		self.onLive(async (ctx) => {
			for (let tick = 1; !signalOf(ctx).aborted; tick++) {
				await sleep(TYPING_MS, ctx);
				if (Object.keys(state.value.repairs).length)
					await linkMutations.run(() => reconcile(ctx)).catch((error: unknown) =>
						console.error("p2 discord: retrying pending link recovery:", errorText(error)));

				await relay.typing();
				if (tick % CHECK_EVERY === 0 && Object.keys(state.value.pending).length)
					await relay.checkPending().catch(() => {});
			}
		});
		// A session's status changed: its turn may have ended.
		let seen: Record<string, string> = {};
		self.on(statuses.statuses, async ({ value }) => {
			const changed = new Set<string>();
			const next: Record<string, string> = {};
			for (const [session, status] of Object.entries(value)) {
				next[session] = `${status.running} ${status.tasks} ${status.busy.join(",")}`;
				if (next[session] !== seen[session]) changed.add(session);
			}
			seen = next;
			if (live && changed.size && Object.keys(state.value.pending).length)
				await relay.checkPending(changed).catch((error: unknown) => console.error("p2 discord:", errorText(error)));
		});
		// The bots' avatars for the owner's sheets: the page's CSP allows only its own images, so they come through here.
		const avatars = new Map<string, Promise<{ type: string; bytes: Buffer }>>();
		self.contribute(Routes, {
			"GET /discord/avatar": async (request, response, { principal }) => {
				const bot = new URL(request.url ?? "/", "http://localhost").searchParams.get("bot") ?? "";
				const status = fleet.value.views().find((view) => view.id === bot)?.status;
				const url = status?.state === "connected" ? status.avatarUrl : undefined;
				if (!isOwner(principal) || !url) {
					response.writeHead(404);
					response.end();
					return;
				}
				try {
					let avatar = avatars.get(url);
					if (!avatar) {
						avatar = fetchAvatar(url);
						avatars.set(url, avatar);
						avatar.catch(() => avatars.delete(url));
					}
					const { type, bytes } = await avatar;
					response.writeHead(200, {
						"Content-Type": type,
						"Content-Length": bytes.length,
						"Cache-Control": "private, max-age=86400",
						"Cross-Origin-Resource-Policy": "same-origin",
					});
					response.end(bytes);
				} catch {
					response.writeHead(502);
					response.end();
				}
			},
		});
		const connected = (bot: string) => {
			const found = fleet.value.connected(bot);
			if (!found) throw new Error("The Discord bot is not connected");
			return found;
		};
		/** Drops `session`'s link and lifts its lock; its agents stop being told they answer Discord. */
		const unlink = async (session: string, ctx: Ctx): Promise<void> => {
			if (!Object.values(state.value.bindings).some((binding) => binding.session === session)) return;
			// A single persisted commit first revokes Discord ingress and records the
			// lock-release intent. A restart can safely retry a failed lock write.
			await state.change((draft) => {
				draft.repairs[session] = { kind: "unlink", session, lock: null, expectedLock: locks.locks.value[session] ?? null };
				removeSessionBinding(draft as unknown as LinkRepairState, session);
			}, ctx);
			await reconcile(ctx);
		};
		return {
			bots: followNative(
				self,
				(changed) => fleet.value.subscribe(changed),
				() => fleet.value.views(),
			),
			bindings: deriveTyped(self, [state], ([value]) =>
				Object.values(value.bindings).sort((a, b) => a.createdAt - b.createdAt),
			),
			addBot: async ({ token }) => ({ id: await fleet.value.add(token) }),
			setBotToken: async ({ bot, token }) => {
				await fleet.value.setToken(bot, token);
				return null;
			},
			removeBot: ({ bot }, ctx) => linkExclusive(ctx, async () => {
				for (const binding of Object.values(state.value.bindings))
					if (binding.botId === bot) await unlink(binding.session, ctx);
				await fleet.value.remove(bot);
				return null;
			}),
			server: ({ bot, guild }) => connected(bot).server(guild),
			mcpServers: async () => {
				const text = await optionalText(join(dataDir(), "mcp.json"));
				return text ? mcpServerNames(text) : [];
			},
			link: ({ session, bot, guild, channel: channelId, wake, sandbox, lock }, ctx) => linkExclusive(ctx, async () => {
				const bindings = Object.values(state.value.bindings);
				if (bindings.some((binding) => binding.session === session))
					throw new Error("This session is linked already: unlink it first");
				if (state.value.bindings[channelId]) throw new Error("This channel is linked to another session");
				const config = envs.configs.value[sandbox];
				if (config?.type !== "gondolin") throw new Error(`No sandbox ${sandbox}`);
				const row = catalog.sessions.value.find((entry) => entry.id === session);
				if (!row || row.archivedAt !== null) throw new Error("No such session");
				const channel = await connected(bot).channel(channelId);
				if (channel.thread || channel.guildId !== guild) throw new Error("Pick a channel of the server");
				// Durable compensation is recorded before relocation or lock changes.
				// Relocation may remain in the safer sandbox if a later step fails.
				const priorLock = locks.locks.value[session] ?? null;
				await state.change((draft) => {
					draft.repairs[session] = { kind: "link", session, lock: priorLock, proposedLock: lock };
				}, ctx);
				try {
					// As the owner's Relocate: the session works in the sandbox from now on.
					if (row.env !== sandbox) {
						const cwd = config.mounts?.[0]?.guest ?? "/root";
						const { refused } = await moves.relocate({ id: session, cwd, env: sandbox }, ctx);
						if (refused) throw new Error(`The session could not move into ${sandbox}: ${refused}`);
					}
					await locks.set({ session, lock }, ctx);
					await state.change((draft) => {
						if (Object.values(draft.bindings).some((binding) => binding.session === session))
							throw new Error("This session is linked already: unlink it first");
						if (draft.bindings[channelId]) throw new Error("This channel is linked to another session");
						draft.bindings[channelId] = {
							botId: bot,
							channelId,
							channelName: channel.name,
							guildId: channel.guildId,
							guildName: channel.guildName,
							session,
							wake,
							// The first mention delivers what comes after linking.
							cursor: channel.lastMessageId,
							threads: {},
							createdAt: Date.now(),
							generation: randomUUID(),
						};
						delete draft.repairs[session];
					}, ctx);
				} catch (error) {
					// If the binding was already atomically committed, never roll back its lock.
					if (!Object.values(state.value.bindings).some((binding) => binding.session === session)) {
						try {
							await reconcile(ctx);
						} catch (repairError) {
							console.error("p2 discord: link compensation pending:", errorText(repairError));
							throw new Error("Discord link failed and lock repair is pending; retry after recovery", { cause: error });
						}
					}
					throw error;
				}
				return null;
			}),
			unlink: ({ session }, ctx) => linkExclusive(ctx, async () => {
				await unlink(session, ctx);
				return null;
			}),
			updateLink: ({ session, wake, lock }, ctx) => linkExclusive(ctx, async () => {
				if (!Object.values(state.value.bindings).some((binding) => binding.session === session))
					throw new Error("This session is not linked");
				// Record the owner's desired policy before changing the session's lock.
				// A crash after either write resumes the same update on startup.
				await state.change((draft) => {
					draft.repairs[session] = { kind: "update", session, lock, expectedLock: locks.locks.value[session] ?? null, wake };
				}, ctx);
				await reconcile(ctx);
				return null;
			}),
		};
	});

	host.serve(
		Discord,
		(_params, principal, self) => {
			if (!isOwner(principal)) throw forbidden("Discord is the owner's");
			const store = self.get(DiscordStore, {});
			return {
				variant: "owner",
				members: {
					bots: store.bots,
					bindings: store.bindings,
					addBot: (args, ctx) => store.addBot(args, ctx),
					setBotToken: (args, ctx) => store.setBotToken(args, ctx),
					removeBot: (args, ctx) => store.removeBot(args, ctx),
					server: (args, ctx) => store.server(args, ctx),
					mcpServers: (ctx) => store.mcpServers(ctx),
					link: (args, ctx) => store.link(args, ctx),
					unlink: (args, ctx) => store.unlink(args, ctx),
					updateLink: (args, ctx) => store.updateLink(args, ctx),
				},
			};
		},
		{ accepts: DISCORD_ACCEPTS },
	);
});

/** A Discord avatar (an image of Discord's CDN, a trust boundary: only images pass). */
async function fetchAvatar(url: string): Promise<{ type: string; bytes: Buffer }> {
	if (!url.startsWith("https://cdn.discordapp.com/")) throw new Error("Not a Discord avatar");
	const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
	const type = response.headers.get("content-type") ?? "";
	if (!response.ok || !/^image\/(png|jpeg|gif|webp)$/.test(type)) throw new Error("No avatar");
	return { type, bytes: Buffer.from(await response.arrayBuffer()) };
}

/** `Discord` 2 (pages loaded before `updateLink`): the same state and methods, without it. */
const DISCORD_ACCEPTS: AcceptsTable<typeof Discord> = { 2: {} };

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The server names of `mcp.json` (a trust boundary: the owner's file; the MCP plugin reports what is wrong in it). */
function mcpServerNames(text: string): string[] {
	try {
		const value: unknown = JSON.parse(stripJsonComments(text.replace(/^\uFEFF/, "")));
		const servers = value && typeof value === "object" && "mcpServers" in value ? value.mcpServers : undefined;
		return servers && typeof servers === "object" ? Object.keys(servers).sort() : [];
	} catch {
		return [];
	}
}
