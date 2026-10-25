import type { Attachment, BrainProvider } from "../brain/Provider.js";
import { createProviderFor } from "../brain/index.js";
import { guardEndpoint } from "../setup/memory.js";
import { loadTeamConfig } from "./config.js";

/**
 * The vision model (Settings → Brain team → Pictures): a model that can see, which reads photos
 * for a chat model that can't. Its reading is added as text, so any model can work with the
 * picture; a model that can see still gets the picture too.
 */

const READ = "Read this picture for someone who can't see it. Write out every word, number and equation exactly as it appears (math as LaTeX in $…$), keep the layout (headings, lists, tables), and describe any drawing, circuit or graph in a sentence or two. Mark anything you can't read as [?]. Don't solve or explain anything.";

/** What the vision model reads in the pictures, or null when none is set or it can't be reached
 *  (then the pictures go on as they are). `make` is for tests. */
export async function visionReading(images: Array<{ mimeType: string; data: string }>, make: (e: NonNullable<Awaited<ReturnType<typeof loadTeamConfig>>["vision"]>) => Promise<BrainProvider> = createProvider): Promise<string | null> {
  if (!images.length) return null;
  const { vision } = await loadTeamConfig();
  if (!vision) return null;
  try {
    const provider = await make(vision);
    const attachments: Attachment[] = images.map((img, i) => ({ kind: "image", mimeType: img.mimeType, data: img.data, name: `picture-${i + 1}` }));
    let text = "";
    for await (const ev of provider.chat([{ role: "user", content: READ, attachments }], [], { system: "You transcribe pictures faithfully.", maxTokens: 2048 })) {
      if (ev.type === "text-delta") text += ev.text;
      else if (ev.type === "error") return null;
    }
    return text.trim() || null;
  } catch {
    return null;
  }
}

async function createProvider(endpoint: { provider: "anthropic" | "openai-compatible" | "ollama"; model: string; baseUrl: string | null }): Promise<BrainProvider> {
  await guardEndpoint(endpoint);
  return createProviderFor(endpoint);
}

/** A tool's or message's text with the vision model's reading added. */
export const withReading = (text: string, reading: string | null) => (reading ? `${text}\n\nThe vision model's reading of the picture:\n${reading}` : text);
