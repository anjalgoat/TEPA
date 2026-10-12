import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import type { Pool } from "pg";
import { createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { createApp } from "../../app.js";
import { parseStartupConfig } from "../../config.js";

async function freePort() {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No local port");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return address.port;
}

async function until<T>(read: () => Promise<T | null>, label: string, attempts = 100): Promise<T> {
    for (let attempt = 0; attempt < attempts; attempt++) {
        const value = await read().catch(() => null);
        if (value !== null) return value;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for ${label}`);
}

export async function claimInLocalBrowser(input: {
    pool: Pool;
    databaseUrl: string;
    rpcUrl: string;
    tokenAddress: `0x${string}`;
    assetAddress: `0x${string}`;
    holderKeys: Hex[];
    browserBin: string;
    action?: "claim" | "settle";
    settlementCaseId?: string;
    distributionEpochId?: string;
}) {
    const profile = await mkdtemp(path.join(tmpdir(), "tepa-browser-claim-"));
    const webPort = await freePort();
    const debugPort = await freePort();
    const config = parseStartupConfig({
        APP_ENV: "test",
        DATABASE_URL: input.databaseUrl,
        CHAIN_RPC_URL: input.rpcUrl,
        TEPA_TOKEN_ADDRESS: input.tokenAddress,
        TEST_USDC_ADDRESS: input.assetAddress,
        WEB_ORIGIN: `http://127.0.0.1:${webPort}`,
    });
    const api = createApp(config, input.pool).listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => api.once("listening", resolve));
    const apiAddress = api.address();
    if (!apiAddress || typeof apiAddress === "string") throw new Error("No API port");
    const repo = path.resolve(process.cwd(), "../..");
    let web: ChildProcess | undefined;
    let browser: ChildProcess | undefined;
    let socket: WebSocket | undefined;
    try {
        web = spawn(
            "npm",
            [
                "run",
                "dev",
                "-w",
                "@tepa/web",
                "--",
                "--host",
                "127.0.0.1",
                "--port",
                String(webPort),
                "--strictPort",
            ],
            {
                cwd: repo,
                env: { ...process.env, VITE_API_URL: `http://127.0.0.1:${apiAddress.port}` },
                stdio: "ignore",
            },
        );
        await until(async () => {
            const response = await fetch(`http://127.0.0.1:${webPort}`);
            return response.ok ? true : null;
        }, "local web server");
        browser = spawn(
            input.browserBin,
            [
                "--headless=new",
                "--no-sandbox",
                "--disable-gpu",
                "--disable-extensions",
                `--user-data-dir=${profile}`,
                `--remote-debugging-port=${debugPort}`,
                "about:blank",
            ],
            { stdio: "ignore" },
        );
        const page = await until(async () => {
            const response = await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, {
                method: "PUT",
            });
            if (!response.ok) return null;
            return (await response.json()) as { webSocketDebuggerUrl: string };
        }, "browser debugging page");
        socket = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise<void>((resolve, reject) => {
            socket!.addEventListener("open", () => resolve(), { once: true });
            socket!.addEventListener("error", () => reject(new Error("Browser socket failed")), {
                once: true,
            });
        });
        let nextId = 0;
        let activeHolder = 0;
        type CdpResult = { exceptionDetails?: { text: string }; result?: { value?: unknown } };
        const pending = new Map<
            number,
            { resolve: (value: CdpResult) => void; reject: (error: Error) => void }
        >();
        const wallets = input.holderKeys.map((key) =>
            createWalletClient({
                account: privateKeyToAccount(key),
                chain: foundry,
                transport: http(input.rpcUrl),
            }),
        );
        const send = (method: string, params: Record<string, unknown> = {}) =>
            new Promise<CdpResult>((resolve, reject) => {
                const id = ++nextId;
                pending.set(id, { resolve, reject });
                socket!.send(JSON.stringify({ id, method, params }));
            });
        const evaluate = async (expression: string) => {
            const result = await send("Runtime.evaluate", {
                expression,
                returnByValue: true,
                awaitPromise: true,
            });
            if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
            return result.result?.value;
        };
        socket.addEventListener("message", (event) => {
            const message = JSON.parse(String(event.data));
            if (message.id) {
                const request = pending.get(message.id);
                pending.delete(message.id);
                if (message.error) request?.reject(new Error(message.error.message));
                else request?.resolve(message.result);
            } else if (
                message.method === "Runtime.bindingCalled" &&
                message.params?.name === "tepaWalletBridge"
            ) {
                const request = JSON.parse(message.params.payload) as {
                    id: number;
                    method: string;
                    params?: unknown[];
                };
                void (async () => {
                    try {
                        let result: unknown;
                        if (request.method === "eth_chainId") result = "0x7a69";
                        else if (request.method === "eth_requestAccounts")
                            result = [wallets[activeHolder]!.account.address];
                        else if (request.method === "eth_sendTransaction") {
                            const tx = request.params?.[0] as { from: Hex; to: Hex; data: Hex };
                            if (
                                tx.from.toLowerCase() !== wallets[activeHolder]!.account.address.toLowerCase()
                            )
                                throw new Error("Wrong fictional holder wallet");
                            result = await wallets[activeHolder]!.sendTransaction({
                                to: tx.to,
                                data: tx.data,
                            });
                        } else throw new Error(`Unexpected wallet method ${request.method}`);
                        await evaluate(
                            `window.tepaWalletDone(${request.id}, ${JSON.stringify(result)}, null)`,
                        );
                    } catch (error) {
                        await evaluate(
                            `window.tepaWalletDone(${request.id}, null, ${JSON.stringify(error instanceof Error ? error.message : String(error))})`,
                        );
                    }
                })();
            }
        });
        await send("Runtime.enable");
        await send("Page.enable");
        await send("Runtime.addBinding", { name: "tepaWalletBridge" });
        await send("Page.addScriptToEvaluateOnNewDocument", {
            source: `window.tepaWalletPending = new Map(); window.tepaWalletNextId = 0;
                window.tepaWalletDone = (id, value, error) => {
                    const pending = window.tepaWalletPending.get(id);
                    window.tepaWalletPending.delete(id);
                    if (error) pending.reject(new Error(error)); else pending.resolve(value);
                };
                window.ethereum = { request: ({ method, params }) => new Promise((resolve, reject) => {
                    const id = ++window.tepaWalletNextId;
                    window.tepaWalletPending.set(id, { resolve, reject });
                    window.tepaWalletBridge(JSON.stringify({ id, method, params }));
                }) };`,
        });
        await send("Page.navigate", { url: `http://127.0.0.1:${webPort}/demo` });
        for (const [index, role] of ["INVESTOR_A", "INVESTOR_B"].entries()) {
            activeHolder = index;
            const holderCaption = index === 0 ? "holder A" : "holder B";
            await until(async () => {
                const ready = await evaluate(
                    `Boolean(document.querySelector('#demo-role') && document.querySelector('.presenter-controls'))`,
                );
                return ready ? true : null;
            }, "presenter controls");
            const manualControlsClosed = await evaluate(
                `document.querySelector('.presenter-controls').open === false && document.querySelector('#demo-role').value === 'ISSUER_PREPARER'`,
            );
            if (!manualControlsClosed)
                throw new Error("The browser test requires the untouched presenter controls");
            if (input.action === "settle") {
                if (!input.settlementCaseId) throw new Error("Settlement case ID is required");
                const caseRow = await input.pool.query<{ kind: string }>(
                    "SELECT kind FROM phase4_cases WHERE id=$1",
                    [input.settlementCaseId],
                );
                const stepLabel = caseRow.rows[0]?.kind === "ACQUISITION" ? "Acquisition" : "Buyback";
                await until(async () => {
                    const ready = await evaluate(
                        `Boolean([...document.querySelectorAll('.journey-steps button')].find(button => button.textContent.includes(${JSON.stringify(stepLabel)})))`,
                    );
                    return ready ? true : null;
                }, `${stepLabel} step`);
                await evaluate(`([...document.querySelectorAll('.journey-steps button')]
                    .find(button => button.textContent.includes(${JSON.stringify(stepLabel)}))).click()`);
                await until(async () => {
                    const ready = await evaluate(
                        `Boolean([...document.querySelectorAll('button')].find(button => button.textContent.includes('Receive test USDC and burn accepted units') && button.textContent.includes(${JSON.stringify(holderCaption)})))`,
                    );
                    return ready ? true : null;
                }, `${role} settlement button`);
                await evaluate(
                    `([...document.querySelectorAll('button')].find(button => button.textContent.includes('Receive test USDC and burn accepted units') && button.textContent.includes(${JSON.stringify(holderCaption)}))).click()`,
                );
                try {
                    await until(
                        async () => {
                            const receipt = await input.pool.query(
                                `SELECT r.id FROM phase4_receipts r JOIN phase4_allocations a ON a.id=r.allocation_id
                             JOIN phase2_holders h ON h.id=a.holder_id
                             WHERE a.case_id=$1 AND h.holder_ref=$2`,
                                [
                                    input.settlementCaseId,
                                    index === 0 ? "synthetic-holder-a" : "synthetic-holder-b",
                                ],
                            );
                            return receipt.rows[0] ?? null;
                        },
                        `${role} browser settlement`,
                        150,
                    );
                } catch (error) {
                    throw new Error(
                        `${String(error)}; page: ${String(await evaluate(`document.body.innerText.slice(-2500)`))}`,
                    );
                }
                const actingRole = await evaluate(`document.querySelector('.acting-role')?.textContent`);
                if (!String(actingRole).includes(index === 0 ? "Fictional holder A" : "Fictional holder B"))
                    throw new Error(`Action role did not switch for ${role}: ${String(actingRole)}`);
                continue;
            }
            await until(async () => {
                const ready = await evaluate(
                    `Boolean([...document.querySelectorAll('.journey-steps button')].find(button => button.textContent.includes('Distribution')))`,
                );
                return ready ? true : null;
            }, "distribution step");
            await evaluate(`([...document.querySelectorAll('.journey-steps button')]
                .find(button => button.textContent.includes('Distribution'))).click()`);
            try {
                await until(async () => {
                    const ready = await evaluate(
                        `Boolean([...document.querySelectorAll('button')].find(button => button.textContent.includes('Claim this test USDC entitlement')))`,
                    );
                    return ready ? true : null;
                }, "distribution controls");
            } catch (error) {
                throw new Error(
                    `${String(error)}; page: ${String(await evaluate(`document.body.innerText.slice(-2500)`))}`,
                );
            }
            try {
                await until(async () => {
                    const ready = await evaluate(
                        `Boolean([...document.querySelectorAll('button')].find(button => button.textContent.includes('Claim this test USDC entitlement') && button.textContent.includes(${JSON.stringify(holderCaption)})))`,
                    );
                    return ready ? true : null;
                }, `${role} claim button`);
            } catch (error) {
                throw new Error(
                    `${String(error)}; page: ${String(await evaluate(`document.body.innerText.slice(-1800)`))}`,
                );
            }
            await evaluate(
                `([...document.querySelectorAll('button')].find(button => button.textContent.includes('Claim this test USDC entitlement') && button.textContent.includes(${JSON.stringify(holderCaption)}))).click()`,
            );
            if (!input.distributionEpochId) throw new Error("Distribution epoch ID is required");
            try {
                await until(
                    async () => {
                        const receipt = await input.pool.query(
                            `SELECT c.id FROM distribution_claims c JOIN distribution_entitlements e ON e.id=c.entitlement_id
                         JOIN phase2_holders h ON h.id=e.holder_id
                         WHERE e.epoch_id=$1 AND h.holder_ref=$2`,
                            [
                                input.distributionEpochId,
                                index === 0 ? "synthetic-holder-a" : "synthetic-holder-b",
                            ],
                        );
                        return receipt.rows[0] ?? null;
                    },
                    `${role} browser claim`,
                    150,
                );
            } catch (error) {
                throw new Error(
                    `${String(error)}; page: ${String(await evaluate(`document.body.innerText.slice(-1800)`))}`,
                );
            }
            const actingRole = await evaluate(`document.querySelector('.acting-role')?.textContent`);
            if (!String(actingRole).includes(index === 0 ? "Fictional holder A" : "Fictional holder B"))
                throw new Error(`Action role did not switch for ${role}: ${String(actingRole)}`);
        }
        if (input.action === "settle") {
            await send("Emulation.setDeviceMetricsOverride", {
                width: 375,
                height: 812,
                deviceScaleFactor: 1,
                mobile: true,
            });
            for (const label of [
                "Deal",
                "Verified cash",
                "Issuance",
                "Transfer blocked",
                "Distribution",
                "Buyback",
                "Acquisition",
                "Verify",
            ]) {
                await evaluate(`([...document.querySelectorAll('.journey-steps button')]
                    .find(button => button.textContent.includes(${JSON.stringify(label)}))).click()`);
                await new Promise((resolve) => setTimeout(resolve, 150));
                const width = (await evaluate(`({ viewport: window.innerWidth,
                    document: document.documentElement.scrollWidth, body: document.body.scrollWidth })`)) as {
                    viewport: number;
                    document: number;
                    body: number;
                };
                if (Math.max(width.document, width.body) > width.viewport + 1)
                    throw new Error(`Horizontal overflow at 375px on ${label}: ${JSON.stringify(width)}`);
            }
        }
    } finally {
        socket?.close();
        browser?.kill("SIGTERM");
        web?.kill("SIGTERM");
        await new Promise<void>((resolve) => api.close(() => resolve()));
        if (browser && browser.exitCode === null)
            await Promise.race([
                new Promise<void>((resolve) => browser!.once("exit", () => resolve())),
                new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
            ]);
        for (let attempt = 0; attempt < 5; attempt++) {
            try {
                await rm(profile, { recursive: true, force: true });
                break;
            } catch {
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
        }
    }
}

export async function settleInLocalBrowser(input: Parameters<typeof claimInLocalBrowser>[0]) {
    return claimInLocalBrowser({ ...input, action: "settle" });
}
