import { jsonValueSchema } from "../domain/jsonValue.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../domain/analysisErrorCore.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { createEvidence, type Evidence } from "../domain/evidence.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  cutterCommandInputSchema,
  type CutterCommandInput,
} from "../contracts/cutterToolContracts.js";
import {
  CutterBridgeClient,
  type CutterBridgeDiscovery,
  type CutterBridgeExecution,
  type CutterDiscoveryOptions,
} from "./CutterBridgeClient.js";
import { CUTTER_PROVIDER_IDENTITY } from "./CutterBridgeClient.js";

interface CutterBridgePort {
  listSessions(
    options?: CutterDiscoveryOptions,
  ): Promise<CutterBridgeDiscovery>;
  confirmCommandCompletion?(
    sessionId: string,
    requestId: string,
    completionToken?: string,
  ): Promise<Result<boolean, AnalysisError>>;
  retryCleanup?(): Promise<boolean>;
  execute(input: {
    readonly sessionId: string;
    readonly expectedGeneration: number;
    readonly command: string;
    readonly json: boolean;
    readonly signal?: AbortSignal;
  }): Promise<CutterBridgeExecution>;
}

/** Shared Cutter bridge workflows used by the MCP adapter and CLI. */
export class CutterBridgeService {
  #cleanupAttempt: Promise<Result<null, AnalysisError>> | undefined;
  readonly #pendingCleanup = new Map<
    string,
    {
      readonly sessionId: string;
      readonly completionToken?: string;
      readonly failure: AnalysisOutputError;
    }
  >();
  /**
   * The last descriptor-cleanup error reported to a caller. It stays retained
   * (and keeps `cleanupIncomplete`) until the retained handles are confirmed
   * closed, so a later retry can resolve the exact error a caller holds.
   */
  #descriptorCleanupFailure: AnalysisCapabilityUnavailableError | undefined;

  constructor(readonly client: CutterBridgePort = new CutterBridgeClient()) {}

  /** Release timed-out work only after producer-owned terminal proof. */
  retryCleanup(): Promise<Result<null, AnalysisError>> {
    if (this.#cleanupAttempt !== undefined) return this.#cleanupAttempt;
    const attempt = this.#retryPendingCleanup().finally(() => {
      if (this.#cleanupAttempt === attempt) this.#cleanupAttempt = undefined;
    });
    this.#cleanupAttempt = attempt;
    return attempt;
  }

  async #retryPendingCleanup(): Promise<Result<null, AnalysisError>> {
    for (const [requestId, pending] of this.#pendingCleanup) {
      const confirmCommandCompletion = this.client.confirmCommandCompletion;
      if (confirmCommandCompletion === undefined) return err(pending.failure);
      const receipt = await confirmCommandCompletion.call(
        this.client,
        pending.sessionId,
        requestId,
        pending.completionToken,
      );
      if (!receipt.ok || !receipt.value) return err(pending.failure);
      const { failure } = pending;
      failure.resolveCleanup();
      this.#pendingCleanup.delete(requestId);
    }
    // Retry descriptor handles retained by a failed close. When every owner is
    // released, drop the retained error so a later close failure produces a
    // fresh error instead of reusing an already-resolved one.
    const retry = this.client.retryCleanup;
    if (retry !== undefined) {
      const released = await retry.call(this.client);
      if (released) {
        this.#descriptorCleanupFailure?.resolveCleanup();
        this.#descriptorCleanupFailure = undefined;
      } else if (this.#descriptorCleanupFailure !== undefined)
        return err(this.#descriptorCleanupFailure);
    }
    return ok(null);
  }

  /**
   * Confirm descriptor handles left by failed discovery closes are released.
   * A retained descriptor blocks a new command until its owner confirms close.
   */
  async #descriptorCleanupReady(): Promise<boolean> {
    const retry = this.client.retryCleanup;
    return retry === undefined ? true : retry.call(this.client);
  }

  /** Retain one descriptor-cleanup error so a later retry can resolve it. */
  #descriptorCleanupError(): AnalysisCapabilityUnavailableError {
    this.#descriptorCleanupFailure ??= new AnalysisCapabilityUnavailableError(
      "cutter",
      "cutter_command",
      "Cutter descriptor cleanup is incomplete; a retained handle blocks a new command until it is released.",
      {
        cleanup: {
          reason:
            "A descriptor handle opened during discovery could not be confirmed closed.",
          resources: ["cutter-descriptor-handle"],
        },
      },
    );
    return this.#descriptorCleanupFailure;
  }

  async listSessions(
    options: CutterDiscoveryOptions = {},
  ): Promise<Result<CutterBridgeDiscovery, AnalysisError>> {
    const { signal } = options;
    try {
      signal?.throwIfAborted();
      const discovery = await this.client.listSessions(options);
      signal?.throwIfAborted();
      return ok(discovery);
    } catch (cause) {
      if (signal?.aborted)
        return err(
          new AnalysisCancelledError("list_cutter_sessions", {
            cause: signal.reason,
          }),
        );
      return err(
        cause instanceof AnalysisError
          ? cause
          : new AnalysisCapabilityUnavailableError(
              "cutter",
              "list_cutter_sessions",
              cause instanceof Error
                ? cause.message
                : "Cutter discovery failed",
              { cause },
            ),
      );
    }
  }

  async execute(
    rawInput: unknown,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<Result<Evidence, AnalysisError>> {
    const parsed = cutterCommandInputSchema.safeParse(rawInput);
    if (!parsed.success) return err(new AnalysisInputError("cutter_command"));
    if (options.signal?.aborted)
      return err(
        new AnalysisCancelledError("cutter_command", {
          cause: options.signal.reason,
        }),
      );
    const input = parsed.data;
    // Release timed-out command receipts and retained descriptor handles. A
    // retained descriptor keeps its error until every owner confirms close.
    const cleanup = await this.retryCleanup();
    if (!cleanup.ok) return err(cleanup.error);
    // A descriptor whose close was never confirmed keeps its ownership; do not
    // start a new command until that handle is released. `client.execute` also
    // rechecks after its own discovery, which can retain a new handle.
    if (!(await this.#descriptorCleanupReady()))
      return err(this.#descriptorCleanupError());
    try {
      const output = await this.client.execute({
        sessionId: input.session_id,
        expectedGeneration: input.expected_generation,
        command: input.command,
        json: input.json,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      const evidence = this.#commandEvidence(input, output);
      if (output.executionState === "unknown") {
        const failure = new AnalysisOutputError(
          "cutter_command",
          "Cutter command completion is unknown; the bound binary remains unavailable until the UI dispatcher confirms this request reached a terminal state.",
          {
            cleanup: {
              reason:
                "The exact UI dispatcher completion receipt has not arrived; the dispatched command may still be running.",
              resources: [`cutter-session:${input.session_id}`],
            },
            partialObservation: evidence,
          },
        );
        this.#pendingCleanup.set(output.requestId, {
          sessionId: input.session_id,
          ...(output.completionToken === undefined
            ? {}
            : { completionToken: output.completionToken }),
          failure,
        });
        return err(failure);
      }
      if (options.signal?.aborted)
        return err(
          new AnalysisCancelledError("cutter_command", {
            cause: options.signal.reason,
            partialObservation: evidence,
          }),
        );
      return ok(evidence);
    } catch (cause) {
      if (cause instanceof AnalysisError) {
        // The client rechecks descriptor cleanup after its own discovery and
        // can raise a cleanup failure the service never created. Retain it so a
        // later retry resolves the exact error the caller holds; otherwise the
        // error stays `cleanupIncomplete` with no owner able to clear it.
        if (
          cause instanceof AnalysisCapabilityUnavailableError &&
          cause.cleanupIncomplete &&
          cause.cleanupResources.includes("cutter-descriptor-handle")
        )
          this.#descriptorCleanupFailure = cause;
        return err(cause);
      }
      const message =
        cause instanceof Error
          ? cause.message
          : "Unknown Cutter bridge failure";
      if (options.signal?.aborted && !message.includes("may have completed"))
        return err(new AnalysisCancelledError("cutter_command", { cause }));
      return err(
        message.includes("generation changed") ||
          message.includes("unavailable or stale")
          ? new AnalysisInputError("cutter_command", { cause })
          : new AnalysisCapabilityUnavailableError(
              "cutter",
              "cutter_command",
              message,
              { cause },
            ),
      );
    }
  }

  /** Build the command Evidence shared by success and unknown-completion paths. */
  #commandEvidence(
    input: CutterCommandInput,
    output: CutterBridgeExecution,
  ): Evidence {
    const normalizedOutput = jsonValueSchema.parse(output.output);
    return createEvidence(
      undefined,
      {
        ...CUTTER_PROVIDER_IDENTITY,
        version: output.cutterVersion,
      },
      {
        predicateType: "rea.cutter.command-observation",
        operation: "cutter_command",
        parameters: {
          session_id: input.session_id,
          expected_generation: input.expected_generation,
          command: input.command,
          json: input.json,
        },
        result: {
          command: input.command,
          output: normalizedOutput,
          execution_state: output.executionState,
          error: output.error,
          message: output.message,
          output_truncated: output.outputTruncated,
          cutter_version: output.cutterVersion,
          current_file: output.currentFile,
          document_generation: output.documentGeneration,
          identity_status: output.identityStatus,
        },
        rawResult: normalizedOutput,
        subjectUnavailableReason:
          "Cutter exposes no verified stable identity for the active unsaved document or tab.",
        limitations: [
          "Document identity is partial: the bridge uses a plugin instance UUID and observed generation; a same-path tab switch or reload may not be distinguishable.",
          "Cutter command effects depend on the Rizin command and active plugins.",
          "The local IPC protocol is implemented by REA and is not an upstream Cutter API.",
          ...(output.executionState === "unknown"
            ? [
                "Command completion or its output could not be confirmed; do not retry automatically because the command may have produced partial or persistent effects.",
              ]
            : []),
          ...(output.outputTruncated
            ? [
                "The command completed or may have completed, but output exceeded the bridge transport limit and was omitted.",
              ]
            : []),
        ],
      },
    );
  }
}
