/** Launch a local shell using a detached Node supervisor with capped output. */
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killProcessTree, type ShellConfig } from "../../utils/shell.ts";

export interface BackgroundShellResult {
	pid: number;
	outputPath: string;
}

/** Hard maximum of captured background output; excess bytes are drained, never written. */
export const BACKGROUND_LOG_MAX_BYTES = 2_000_000;

/**
 * Self-contained supervisor source. Its Node executable and this source ship
 * with the bundled Pi CLI; it needs no source-module path, npm package, shell,
 * or optional runtime. The worker inherits a sanitized environment directly;
 * no environment variables are persisted in the request file.
 */
const SUPERVISOR = `
"use strict";
const fs=require("node:fs");
const {spawn}=require("node:child_process");
const {join}=require("node:path");
const folder=process.argv[1];
const requestPath=join(folder,"request.json");
const request=JSON.parse(fs.readFileSync(requestPath,"utf8"));
fs.rmSync(requestPath,{force:true});
const statePath=join(folder,"state.json");
let fd=null,child=null,used=0,truncated=false,done=false;
const save=(patch)=>{
  const state={version:1,workerPid:process.pid,childPid:child?.pid??null,
    outputTruncated:truncated,updatedAt:Date.now(),...patch};
  const tmp=statePath+"."+process.pid+".tmp";
  fs.writeFileSync(tmp,JSON.stringify(state),{mode:0o600});
  fs.renameSync(tmp,statePath);
};
const finish=(status,exitCode,signal,error)=>{
  if(done)return;
  done=true;
  try{if(fd!==null){fs.closeSync(fd);fd=null;}}catch{}
  try{save({status,exitCode,signal:signal||null,error:error||null,finishedAt:Date.now()});}
  catch{process.exitCode=1;}
};
const write=buf=>{
  if(done||fd===null)return;
  const remaining=request.maxLogBytes-used;
  if(remaining<=0){if(buf.length>0)truncated=true;return;}
  let count=Math.min(remaining,buf.length),pos=0;
  while(pos<count){
    const n=fs.writeSync(fd,buf,pos,count-pos);
    if(n<=0)throw new Error("background log write failed");
    pos+=n;
  }
  used+=count;
  if(buf.length>count)truncated=true;
};
try{
  fd=fs.openSync(join(folder,"output.log"),"wx",0o600);
  const opts=request.shellConfig;
  const fromStdin=opts.commandTransport==="stdin";
  child=spawn(opts.shell,fromStdin?opts.args:[...opts.args,request.command],{
    cwd:request.cwd,env:process.env,detached:process.platform!=="win32",
    stdio:[fromStdin?"pipe":"ignore","pipe","pipe"],windowsHide:true
  });
  child.once("spawn",()=>save({status:"running",exitCode:null}));
  child.once("error",e=>finish("failed",null,null,e.code||"spawn failed"));
  for(const stream of [child.stdout,child.stderr]){
    stream.on("data",write);
    stream.on("error",e=>finish("failed",null,null,e.code||"stream failure"));
  }
  if(fromStdin){
    child.stdin.on("error",()=>{});
    child.stdin.end(request.command);
  }
  child.once("exit",()=>{
    const guard=setTimeout(()=>{child.stdout.destroy();child.stderr.destroy();},1000);
    guard.unref();
  });
  child.once("close",(code,signal)=>finish(code===0?"completed":"failed",code,signal,null));
}catch(e){
  try{if(child?.pid)child.kill();}catch{}
  finish("failed",null,null,e.code||"supervisor failure");
}
`;

/**
 * Start a detached, bounded-output shell process while keeping the caller's
 * original cwd and shell configuration. Returns the actual child PID, not the
 * supervisor's PID; the private sibling state.json records its eventual exit.
 */
export async function startBackgroundShell(
	command: string,
	cwd: string,
	shellConfig: ShellConfig,
	env: NodeJS.ProcessEnv,
	tempFilePrefix: string,
): Promise<BackgroundShellResult> {
	await access(cwd, constants.F_OK);
	const folder = await mkdtemp(join(tmpdir(), `${tempFilePrefix}-`));
	let worker: ReturnType<typeof spawn> | undefined;
	try {
		await writeFile(
			join(folder, "request.json"),
			JSON.stringify({
				command,
				cwd,
				shellConfig,
				maxLogBytes: BACKGROUND_LOG_MAX_BYTES,
			}),
			{ flag: "wx", mode: 0o600 },
		);
		// The supervisor's own cwd must not lock the user's project on Windows.
		worker = spawn(process.execPath, ["-e", SUPERVISOR, folder], {
			cwd: tmpdir(),
			detached: true,
			env,
			stdio: "ignore",
			windowsHide: true,
		});
		await new Promise<void>((resolve, reject) => {
			worker!.once("spawn", () => resolve());
			worker!.once("error", reject);
		});
		worker.unref();
		const deadline = Date.now() + 5000;
		while (Date.now() < deadline) {
			try {
				const state = JSON.parse(await readFile(join(folder, "state.json"), "utf8")) as {
					childPid?: number | null;
					status?: string;
					error?: string;
				};
				if (typeof state.childPid === "number" && state.childPid > 0) {
					return { pid: state.childPid, outputPath: join(folder, "output.log") };
				}
				if (state.status === "failed") {
					throw new Error(`Background command failed: ${state.error || "spawn error"}`);
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		throw new Error("Background process did not report a startup PID");
	} catch (error) {
		if (worker?.pid) killProcessTree(worker.pid);
		await rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
		throw error;
	}
}
