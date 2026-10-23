/**
 * HTTP client for Kiro's GenerateAssistantResponse (legacy CodeWhisperer
 * streaming service hosted on runtime.{region}.kiro.dev).
 *
 * All request/response details verified live (2026-10-20):
 * - POST /generateAssistantResponse with trailing slash
 * - x-amz-target: AmazonCodeWhispererStreamingService.GenerateAssistantResponse
 *   (the newer KiroRuntimeService target returns 403 for IdC-Enterprise tokens)
 * - Bearer auth; profileArn required in body AND x-amzn-kiro-profile-arn header
 * - agentMode is header-bound (x-amzn-kiro-agent-mode), never a body member
 * - response: application/vnd.amazon.eventstream (binary frames)
 */
import { AwsEventStreamDecoder, decodeEventStream, type AwsEventStreamEvent } from "./eventstream";


export interface KiroGenerateOptions {
	accessToken: string;
	region: string;
	profileArn: string;
	conversationState: unknown;
	/** additionalModelRequestFields (e.g. output_config.effort) — omit unless the model's control-plane schema declares it. */
	additionalModelRequestFields?: Record<string, unknown>;
	signal?: AbortSignal;
	agentMode?: string;
}

export interface KiroChatError {
	kind: "http" | "event";
	status?: number;
	message: string;
}

/** Typed payload of one decoded event (JSON for this service). */
export interface KiroEvent {
	type: string;
	data: Record<string, unknown>;
}

const RUNTIME_TIMEOUT_MS = 5 * 60 * 1000;

function eventPayload(event: AwsEventStreamEvent): KiroEvent {
	let data: Record<string, unknown> = {};
	if (event.payload.length > 0) {
		try {
			const parsed: unknown = JSON.parse(new TextDecoder().decode(event.payload));
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				data = parsed as Record<string, unknown>;
			}
		} catch {
			data = {};
		}
	}
	return { type: event.type ?? "unknown", data };
}

async function readHttpError(res: Response): Promise<never> {
	let message = `HTTP ${res.status}`;
	try {
		const raw: unknown = await res.json();
		if (raw && typeof raw === "object" && "message" in raw && typeof raw.message === "string") {
			message = raw.message;
		}
	} catch {
		/* keep status-only message */
	}
	const err = new Error(`kiro: ${message} (HTTP ${res.status})`);
	(err as KiroErrorEnvelope).kiroStatus = res.status;
	throw err;
}

/** Attach a kiroStatus marker without inline casting at the throw site. */
interface KiroErrorEnvelope extends Error {
	kiroStatus?: number;
}

/**
 * One-shot request returning every decoded event. Streaming variant below.
 */
export async function generateAssistantResponse(options: KiroGenerateOptions): Promise<KiroEvent[]> {
	const res = await doRequest(options);
	if (!res.ok) await readHttpError(res);
	const body = new Uint8Array(await res.arrayBuffer());
	return decodeEventStream(body).map(eventPayload);
}

/**
 * Streaming request: invokes onEvent for each event as frames complete.
 * Returns when the server closes the stream.
 */
export async function streamAssistantResponse(
	options: KiroGenerateOptions,
	onEvent: (event: KiroEvent) => void,
): Promise<void> {
	const res = await doRequest(options, { timeoutMs: RUNTIME_TIMEOUT_MS });
	if (!res.ok) await readHttpError(res);
	if (!res.body) throw new Error("kiro: response has no body");
	const contentType = res.headers.get("content-type") ?? "";
	if (!contentType.includes("application/vnd.amazon.eventstream")) {
		// JSON error delivered after a 200 (rare) or a proxy interposing.
		const text = await res.text();
		throw new Error(`kiro: unexpected content-type ${contentType}: ${text.slice(0, 200)}`);
	}

	const decoder = new AwsEventStreamDecoder();
	const reader = res.body.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value) {
				for (const event of decoder.push(value)) {
					onEvent(eventPayload(event));
				}
			}
		}
	} finally {
		reader.releaseLock();
	}
}

async function doRequest(options: KiroGenerateOptions, extra?: { timeoutMs?: number }): Promise<Response> {
	const body: Record<string, unknown> = {
		conversationState: options.conversationState,
		profileArn: options.profileArn,
	};
	if (process.env.KIRO_DEBUG_DUMP) {
		// Debug aid: dump the exact wire request for offline inspection.
		console.error(JSON.stringify(body, null, 2));
	}
	if (options.additionalModelRequestFields) {
		body.additionalModelRequestFields = options.additionalModelRequestFields;
	}
	const headers: Record<string, string> = {
		"Content-Type": "application/x-amz-json-1.0",
		"x-amz-target": "AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
		Authorization: `Bearer ${options.accessToken}`,
		"x-amzn-kiro-agent-mode": options.agentMode ?? "vibe",
		"x-amzn-kiro-profile-arn": options.profileArn,
		"x-amzn-codewhisperer-optout": "true",
		"User-Agent": "kiro-cli/2.21.0 linux/x86_64",
	};
	const timeoutMs = extra?.timeoutMs ?? 30_000;
	return fetch(`https://runtime.${options.region}.kiro.dev/generateAssistantResponse/`, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
		signal: options.signal ?? AbortSignal.timeout(timeoutMs),
	});
}

/** Extract the typed error status marker, if present. */
export function kiroErrorStatus(error: unknown): number | undefined {
	if (error instanceof Error && "kiroStatus" in error) {
		const status = (error as KiroErrorEnvelope).kiroStatus;
		return typeof status === "number" ? status : undefined;
	}
	return undefined;
}
