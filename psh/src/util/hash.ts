import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { canonicalJson } from "./json.ts";

export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function sha256Prefixed(data: string | Uint8Array): string {
  return `sha256:${sha256(data)}`;
}

export function sha256File(path: string): string {
  return sha256(readFileSync(path));
}

export function sha256FilePrefixed(path: string): string {
  return `sha256:${sha256File(path)}`;
}

/** Hash estavel de uma estrutura: canonicaliza antes de hashear. */
export function sha256Canonical(value: unknown): string {
  return sha256(canonicalJson(value));
}
