import { AI_MENTION } from "@poof/protocol";
import { utf8 } from "../encoding.ts";
import type { AiPrompt } from "./client.ts";

/**
 * The system prompt: how the chat looks, nothing else. It adds no rules of its own; what
 * "uncensored" means is the model's. Public, like all the engine code.
 */
export const AI_SYSTEM_PROMPT = [
  "You are the AI in a private, temporary group chat.",
  'Messages from people are prefixed with their name, like "Ana: ...", and your own earlier answers with "AI: ...".',
  "Answer the latest message, which is addressed to you.",
  "Reply in the language it was written in.",
  "Be direct and concise unless asked for detail.",
  "You have no memory beyond this conversation and no access to the internet.",
].join(" ");

/**
 * The most conversation sent with one question, in UTF-8 bytes. It keeps the request well inside
 * the model's context and the API's body cap (the ciphertext travels as hex, twice the size).
 */
export const AI_CONTEXT_MAX_BYTES = 120_000;

/** One line of the conversation as the AI sees it. */
export interface AiTurn {
  /** "Ana", "Peer 3FA2", "You" or "AI". */
  speaker: string;
  text: string;
}

/** True if this message asks the AI (it starts with @ai). */
export function mentionsAi(text: string): boolean {
  return AI_MENTION.test(text);
}

/** The question without its leading "@ai". */
export function stripMention(text: string): string {
  return text.replace(AI_MENTION, "").trim();
}

/**
 * The prompt for one question: the system prompt, then as much of the recent conversation as fits
 * (oldest lines dropped first), then the question. Everything goes in one encrypted user message:
 * the provider would see earlier answers sent as assistant turns, which aren't encrypted.
 */
export function buildAiPrompt(history: readonly AiTurn[], question: AiTurn): AiPrompt {
  const last = `${question.speaker}: ${question.text}`;
  let budget = AI_CONTEXT_MAX_BYTES - utf8(last).length;
  const lines: string[] = [];
  for (let i = history.length - 1; i >= 0 && budget > 0; i--) {
    const turn = history[i]!;
    const line = `${turn.speaker}: ${turn.text}`;
    const size = utf8(line).length + 1;
    if (size > budget) break;
    budget -= size;
    lines.unshift(line);
  }
  const user =
    lines.length > 0
      ? `The conversation so far:\n${lines.join("\n")}\n\nThe latest message, to you:\n${last}`
      : last;
  return { system: AI_SYSTEM_PROMPT, user };
}
