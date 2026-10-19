import type { CreateDevice } from "../shared/contracts";

/**
 * P07 client mirror of the accepted C1 validation rules (owner P03). The server
 * stays authoritative: these checks only give immediate field feedback and keep
 * inputs, and any disagreement is still reported through the server envelope.
 *
 * Messages match the server wording so the UI reads the same either way.
 */
const MAX_NAME_CODE_POINTS = 80;
const CONTROL_CHARS = /\p{Cc}/u;
const HEX_OCTET = /^[0-9a-fA-F]{2}$/;
const DECIMAL_OCTET = /^\d{1,3}$/;

export type RawFormInput = {
  name: string;
  macAddress: string;
  /** Blank means no override: the UI sends null (C1). */
  broadcastAddress: string;
};

export type FieldErrors = Partial<
  Record<"name" | "macAddress" | "broadcastAddress", string>
>;

export type ValidatedForm = {
  errors: FieldErrors;
  /** Normalized values ready to send; only present when `errors` is empty. */
  input: CreateDevice;
};

export function validateForm(raw: RawFormInput): ValidatedForm {
  const errors: FieldErrors = {};

  const name = validateName(raw.name);
  if (!name) {
    errors.name = nameError(raw.name);
  }

  const macAddress = validateMacAddress(raw.macAddress);
  if (!macAddress) {
    errors.macAddress = macError(raw.macAddress);
  }

  const broadcastRaw = raw.broadcastAddress.trim();
  let broadcastAddress: string | null = null;
  if (broadcastRaw !== "") {
    broadcastAddress = validateBroadcastAddress(broadcastRaw);
    if (!broadcastAddress) {
      errors.broadcastAddress = broadcastError(broadcastRaw);
    }
  }

  return {
    errors,
    input: { name, macAddress, broadcastAddress },
  };
}

/** Returns the normalized name, or "" when a C1 name rule fails. */
function validateName(value: string): string {
  const name = value.trim();
  if (name.length === 0) {
    return "";
  }
  if (Array.from(name).length > MAX_NAME_CODE_POINTS) {
    return "";
  }
  if (CONTROL_CHARS.test(name)) {
    return "";
  }
  return name;
}

function nameError(value: string): string {
  const name = value.trim();
  if (name.length === 0) {
    return "must not be empty";
  }
  if (Array.from(name).length > MAX_NAME_CODE_POINTS) {
    return `must be at most ${MAX_NAME_CODE_POINTS} characters`;
  }
  if (CONTROL_CHARS.test(name)) {
    return "must not contain control characters";
  }
  return "";
}

function validateMacAddress(value: string): string {
  const trimmed = value.trim();
  const separator = trimmed.includes("-") ? "-" : ":";
  const parts = trimmed.split(separator);
  if (parts.length !== 6 || parts.some((part) => !HEX_OCTET.test(part))) {
    return "";
  }
  const octets = parts.map((part) => part.toUpperCase());
  if (octets.every((octet) => octet === "00")) {
    return "";
  }
  if (octets.every((octet) => octet === "FF")) {
    return "";
  }
  if (Number.parseInt(octets[0], 16) % 2 === 1) {
    return "";
  }
  return octets.join(":");
}

function macError(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return "must not be empty";
  }
  const separator = trimmed.includes("-") ? "-" : ":";
  const parts = trimmed.split(separator);
  if (parts.length !== 6 || parts.some((part) => !HEX_OCTET.test(part))) {
    return 'must be six hex octets separated by ":" or "-" consistently';
  }
  const octets = parts.map((part) => part.toUpperCase());
  if (octets.every((octet) => octet === "00")) {
    return "must not be the all-zero address";
  }
  if (octets.every((octet) => octet === "FF")) {
    return "must not be the all-FF broadcast address";
  }
  if (Number.parseInt(octets[0], 16) % 2 === 1) {
    return "must not be a multicast address";
  }
  return "";
}

function validateBroadcastAddress(value: string): string {
  const parts = value.split(".");
  if (parts.length !== 4 || parts.some((part) => !DECIMAL_OCTET.test(part))) {
    return "";
  }
  if (parts.some((part) => part.length > 1 && part.startsWith("0"))) {
    return "";
  }
  const octets = parts.map((part) => Number(part));
  if (octets.some((octet) => octet < 0 || octet > 255)) {
    return "";
  }
  if (octets.every((octet) => octet === 0)) {
    return "";
  }
  if (octets[0] >= 224 && octets[0] <= 239) {
    return "";
  }
  return octets.join(".");
}

function broadcastError(value: string): string {
  const parts = value.split(".");
  if (parts.length !== 4 || parts.some((part) => !DECIMAL_OCTET.test(part))) {
    return "must be four decimal octets from 0 to 255";
  }
  if (parts.some((part) => part.length > 1 && part.startsWith("0"))) {
    return "octets must not have leading zeros";
  }
  const octets = parts.map((part) => Number(part));
  if (octets.some((octet) => octet < 0 || octet > 255)) {
    return "must be four decimal octets from 0 to 255";
  }
  if (octets.every((octet) => octet === 0)) {
    return "must not be 0.0.0.0";
  }
  if (octets[0] >= 224 && octets[0] <= 239) {
    return "must not be in the multicast range 224.0.0.0/4";
  }
  return "";
}
