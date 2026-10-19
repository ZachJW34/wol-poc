/**
 * P06 — C3 wake service: the per-device state machine between the repository
 * (C1) and the command runner (C3).
 *
 * - Unknown ids never reach the runner and reserve nothing.
 * - A known id reserves its per-device in-flight slot synchronously, before the
 *   first await, so two simultaneous requests can only start one command.
 * - The five-second cooldown starts at command completion on both success and
 *   failure, not at request start.
 * - The state is process-local: it resets when a new `WakeService` is
 *   constructed, while `lastWakeSentAt` stays persistent in the repository.
 * - The device's saved broadcast override is handed to the runner unchanged; a
 *   null override delegates to the installed CLI's default, and clearing an
 *   override therefore restores that CLI default on the next wake.
 *
 * The fixed cooldown constant is not configurable; tests inject the monotonic
 * clock, the wall-clock timestamp provider, and the runner.
 */
import {
  ApplicationError,
  type Device,
  type RunWakeCommand,
} from "../shared/contracts.js";
import type { DeviceRepository } from "./devices.js";

/** C3 fixed per-device cooldown, in milliseconds. */
export const WAKE_COOLDOWN_MS = 5000;

/** C3 wake service contract consumed by the HTTP boundary. */
export interface WakeService {
  wake(id: string): Promise<Device>;
  isBusy(id: string): boolean;
}

export type WakeServiceOptions = {
  /** Persistent device store (C1). Synchronous calls only. */
  repository: DeviceRepository;
  /** The accepted C3 runner. Tests inject a fake; production wires the real one. */
  runWakeCommand: RunWakeCommand;
  /** Monotonic milliseconds clock. Production uses the system clock. */
  nowMs?: () => number;
  /** Wall-clock UTC ISO timestamp provider. Production uses the system clock. */
  timestamp?: () => string;
  /** Internal logging only; never rendered into an HTTP error. */
  onInternalLog?: (message: string) => void;
};

/** Sanitized messages: no process output, SQL, or database paths. */
const WAKE_MESSAGE = "Wake failed.";
const TIMEOUT_MESSAGE = "The wake command timed out.";
const COMMAND_FAILED_MESSAGE = "The wake command failed.";
const IN_FLIGHT_MESSAGE = "A wake is already running for this device.";
const COOLDOWN_MESSAGE = "Wake cooldown is active for this device.";

export function createWakeService(options: WakeServiceOptions): WakeService {
  const { repository, runWakeCommand } = options;
  const nowMs = options.nowMs ?? ((): number => performance.now());
  const timestamp =
    options.timestamp ?? ((): string => new Date().toISOString());
  const log =
    options.onInternalLog ??
    ((message: string): void => {
      console.error(message);
    });

  const inFlight = new Set<string>();
  const cooldownUntil = new Map<string, number>();

  /** True only while a command is running for that device, never during cooldown. */
  function isBusy(id: string): boolean {
    return inFlight.has(id);
  }

  async function wake(id: string): Promise<Device> {
    // Unknown devices are rejected before the runner and reserve no slot.
    const device = repository.get(id);
    if (device === null) {
      throw new ApplicationError("NOT_FOUND", "Device not found.");
    }

    // Everything before the first await runs synchronously, so the slot is
    // reserved in the same turn the request arrives.
    if (inFlight.has(id)) {
      // An in-flight duplicate is rejected immediately, even if a cooldown
      // deadline would otherwise have expired.
      throw new ApplicationError("WAKE_COOLDOWN", IN_FLIGHT_MESSAGE, {
        retryAfterMs: WAKE_COOLDOWN_MS,
      });
    }
    const deadline = cooldownUntil.get(id);
    if (deadline !== undefined) {
      const remaining = deadline - nowMs();
      if (remaining > 0) {
        throw new ApplicationError("WAKE_COOLDOWN", COOLDOWN_MESSAGE, {
          retryAfterMs: remaining,
        });
      }
    }

    inFlight.add(id);
    let commandSucceeded = false;
    try {
      // The device's saved override is passed through unchanged. A null override
      // means the installed CLI's own default applies, so no address is invented
      // or substituted here.
      const result = await runWakeCommand({
        macAddress: device.macAddress,
        broadcastAddress: device.broadcastAddress,
      });
      if (result.kind === "timeout") {
        throw new ApplicationError("WAKE_TIMEOUT", TIMEOUT_MESSAGE);
      }
      if (result.kind === "failed") {
        throw new ApplicationError("WAKE_FAILED", COMMAND_FAILED_MESSAGE);
      }

      // The wall clock is read after command exit, so a slow command does not
      // record a send time earlier than the packet actually left.
      commandSucceeded = true;
      const sentAt = timestamp();
      repository.recordWakeSent(id, sentAt);
      return { ...device, lastWakeSentAt: sentAt };
    } catch (error) {
      if (commandSucceeded) {
        // The packet may already have been sent; only the timestamp failed. C3
        // requires INTERNAL_ERROR for any post-execution timestamp or recording
        // failure, whatever code the provider or storage raises, and the command
        // is never retried for a storage failure.
        log(
          `wake packet may have been sent for device ${id}; ` +
            "the sent timestamp could not be recorded.",
        );
        throw new ApplicationError("INTERNAL_ERROR", WAKE_MESSAGE);
      }
      throw error instanceof ApplicationError
        ? error
        : new ApplicationError("INTERNAL_ERROR", WAKE_MESSAGE);
    } finally {
      // Completion releases busy state and starts the cooldown on every path,
      // including a rejected command and a persistence error.
      inFlight.delete(id);
      cooldownUntil.set(id, nowMs() + WAKE_COOLDOWN_MS);
    }
  }

  return { wake, isBusy };
}
