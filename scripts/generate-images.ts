/**
 * Generate illustrated documentation images using Gemini.
 *
 * Usage:
 *   npx tsx scripts/generate-images.ts <prompt-file.json>
 *   npx tsx scripts/generate-images.ts <prompt-file.json> --only panel-03
 *   npx tsx scripts/generate-images.ts <prompt-file.json> --no-validate
 *   npx tsx scripts/generate-images.ts <prompt-file.json> --max-retries 2
 *
 * Prompt file format: Array of { filename, prompt, alt_text? } objects.
 * Images are saved relative to repo root.
 *
 * After generation, each image is validated using Gemini vision to detect
 * gibberish text and verify alt text accuracy. Images with gibberish are
 * automatically retried with a "no text" directive appended to the prompt.
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import * as fs from "fs";
import * as path from "path";

const BASE_STYLE = `Flat illustration, teal/emerald color palette (#047857 primary, #0d9488 secondary, #134e4a dark accents). Graphic novel style with clean panel borders. Clean, minimal linework with subtle gradients. Tech-forward but warm. No real brand names or logos. Wide aspect ratio suitable for documentation headers (roughly 16:9). Characters should have simple but expressive faces. Use white/light backgrounds for readability.`;

interface ImagePrompt {
  filename: string;
  prompt: string;
  alt_text?: string;
}

interface ValidationResult {
  description: string;
  visible_text: string[];
  gibberish_found: boolean;
  gibberish_details: string;
  matches_description?: boolean;
  match_notes?: string;
}

async function validateImage(
  genAI: GoogleGenerativeAI,
  imageBuffer: Buffer,
  altText?: string,
): Promise<ValidationResult | null> {
  const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

  let validationPrompt =
    `Analyze this image. List ALL text visible in the image verbatim — every word, label, and caption exactly as rendered. ` +
    `Flag any misspelled, garbled, or nonsensical text. ` +
    `Respond ONLY with valid JSON (no markdown fences): ` +
    `{ "description": "brief scene description", "visible_text": ["exact text 1", "exact text 2"], "gibberish_found": true/false, "gibberish_details": "explanation or empty string" }`;

  if (altText) {
    validationPrompt +=
      ` Also assess whether this image matches the following intended description: "${altText}". ` +
      `Add "matches_description": true/false and "match_notes": "explanation" to your JSON response.`;
  }

  try {
    const result = await model.generateContent([
      {
        inlineData: {
          mimeType: "image/png",
          data: imageBuffer.toString("base64"),
        },
      },
      validationPrompt,
    ]);

    const text = result.response.text().trim();
    // Strip markdown fences if present
    const jsonStr = text.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
    return JSON.parse(jsonStr) as ValidationResult;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`  Validation parse error: ${message}`);
    return null;
  }
}

function logValidation(filename: string, result: ValidationResult): void {
  if (result.visible_text.length > 0) {
    console.log(`  Text found: ${result.visible_text.map((t) => `"${t}"`).join(", ")}`);
  }
  if (result.gibberish_found) {
    console.warn(`  ⚠ GIBBERISH DETECTED in ${filename}: ${result.gibberish_details}`);
  }
  if (result.matches_description === false) {
    console.warn(`  ⚠ ALT TEXT MISMATCH in ${filename}: ${result.match_notes}`);
  }
  if (!result.gibberish_found && result.matches_description !== false) {
    console.log(`  ✓ Validation passed`);
  }
}

async function generateAndSaveImage(
  genAI: GoogleGenerativeAI,
  prompt: string,
  outputPath: string,
): Promise<Buffer | null> {
  const model = genAI.getGenerativeModel({
    model: "gemini-3.1-flash-image-preview",
    generationConfig: {
      // @ts-expect-error - responseModalities not in SDK types yet
      responseModalities: ["TEXT", "IMAGE"],
    },
  });

  const result = await model.generateContent(prompt);
  const response = result.response;

  for (const part of response.candidates?.[0]?.content?.parts ?? []) {
    if (part.inlineData) {
      const dir = path.dirname(outputPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const buffer = Buffer.from(part.inlineData.data, "base64");
      fs.writeFileSync(outputPath, buffer);
      console.log(`  Saved: ${outputPath} (${(buffer.length / 1024).toFixed(0)} KB)`);
      return buffer;
    }
  }

  const text = response.text();
  console.error(`  No image generated. Response: ${text.slice(0, 200)}`);
  return null;
}

async function generateImage(
  genAI: GoogleGenerativeAI,
  entry: ImagePrompt,
  options: { validate: boolean; maxRetries: number },
): Promise<void> {
  const fullPrompt = `${BASE_STYLE}\n\n${entry.prompt}`;
  const outputPath = path.resolve(entry.filename);

  console.log(`Generating: ${entry.filename}...`);

  const buffer = await generateAndSaveImage(genAI, fullPrompt, outputPath);
  if (!buffer) return;

  if (!options.validate) return;

  // Validate the generated image
  console.log(`  Validating...`);
  const result = await validateImage(genAI, buffer, entry.alt_text);
  if (!result) return;

  logValidation(entry.filename, result);

  // Retry if gibberish found
  let lastResult = result;
  let retriesLeft = options.maxRetries;

  while (lastResult.gibberish_found && retriesLeft > 0) {
    console.log(`  Retrying with "no text" directive (attempt ${options.maxRetries - retriesLeft + 1}/${options.maxRetries})...`);
    retriesLeft--;
    const retryPrompt = `${fullPrompt}\n\nDo not include any text, words, or labels in the image.`;
    const retryBuffer = await generateAndSaveImage(genAI, retryPrompt, outputPath);
    if (!retryBuffer) return;

    console.log(`  Validating retry...`);
    const retryResult = await validateImage(genAI, retryBuffer, entry.alt_text);
    if (!retryResult) return;

    logValidation(entry.filename, retryResult);
    lastResult = retryResult;
  }

  if (lastResult.gibberish_found) {
    console.warn(`  ⚠ Gibberish persists after retries — keeping image but flagging for manual review`);
  }
}

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("GEMINI_API_KEY not set");
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const promptFile = args[0];
  if (!promptFile) {
    console.error(
      "Usage: npx tsx scripts/generate-images.ts <prompt-file.json> [--only <pattern>] [--no-validate] [--max-retries <n>]",
    );
    process.exit(1);
  }

  const onlyIdx = args.indexOf("--only");
  const onlyPattern = onlyIdx >= 0 ? args[onlyIdx + 1] : null;
  const validate = !args.includes("--no-validate");
  const retriesIdx = args.indexOf("--max-retries");
  const maxRetries = retriesIdx >= 0 ? (parseInt(args[retriesIdx + 1], 10) || 1) : 1;

  const prompts: ImagePrompt[] = JSON.parse(fs.readFileSync(promptFile, "utf-8"));
  const filtered = onlyPattern
    ? prompts.filter((p) => p.filename.includes(onlyPattern))
    : prompts;

  console.log(`Generating ${filtered.length} images (validate: ${validate}, max retries: ${maxRetries})...`);

  const genAI = new GoogleGenerativeAI(apiKey);

  // Generate sequentially to avoid rate limits
  for (const entry of filtered) {
    try {
      await generateImage(genAI, entry, { validate, maxRetries });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  Error generating ${entry.filename}: ${message}`);
    }
  }

  console.log("Done.");
}

main();
