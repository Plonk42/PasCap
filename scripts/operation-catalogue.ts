import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { z } from 'zod';
import { assistantEditCommandSchema } from '../src/shared/command-schema.js';
import { operations } from '../src/shared/operations/index.js';

export const CATALOGUE_DOCUMENT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'docs',
  'design',
  'ASSISTANT_MCP.md',
);
const START = '<!-- operation-catalogue:start -->';
const END = '<!-- operation-catalogue:end -->';

type Json = { type?: string; items?: Json; enum?: unknown[]; const?: unknown; anyOf?: Json[]; oneOf?: Json[] };

function typeName(json: Json): string {
  if (json.const !== undefined) return JSON.stringify(json.const);
  if (json.enum) return json.enum.map((value) => JSON.stringify(value)).join(' or ');
  const options = json.anyOf ?? json.oneOf;
  if (options) {
    const names = [...new Set(options.map(typeName))];
    return names.join(' or ');
  }
  if (json.type === 'array' && json.items) return `array of ${typeName(json.items)}`;
  return json.type ?? 'object';
}

function cell(text: string): string {
  return text.replaceAll('|', String.raw`\|`).replaceAll('\n', ' ');
}

function description(schema: z.ZodType): string {
  return z.globalRegistry.get(schema)?.description ?? '';
}

function code(name: string): string {
  return '`' + name + '`';
}

function fieldRows(schema: z.ZodType): string[] {
  if (!(schema instanceof z.ZodObject)) return [];
  return Object.entries(schema.shape as Record<string, z.ZodType>).map(
    ([name, field]) =>
      `| ${code(name)} | ${cell(typeName(z.toJSONSchema(field, { unrepresentable: 'any' }) as Json))} | ${cell(description(field))} |`,
  );
}

/** The generated Markdown between the catalogue markers. */
export function operationCatalogue(): string {
  const sections = operations.map((operation) =>
    [
      `#### ${code(operation.name)}`,
      '',
      `${operation.access === 'read' ? 'Read' : 'Write'}; for ${operation.audience.join(' and ')}. ${operation.description}`,
      '',
      '| Input | Type | Description |',
      '| --- | --- | --- |',
      ...fieldRows(operation.input),
    ].join('\n'),
  );
  const commands = assistantEditCommandSchema.options.map((option) => {
    const fields = Object.keys(option.shape)
      .filter((name) => name !== 'type')
      .map(code)
      .join(', ');
    return `| ${code(option.shape.type.value)} | ${fields} | ${cell(description(option))} |`;
  });
  return [
    START,
    '',
    '<!-- Generated from src/shared/operations by `npm run operations:catalogue`; edit the definitions, not this text. -->',
    '',
    ...sections.flatMap((section) => [section, '']),
    '#### Edit commands',
    '',
    'The `commands` of `edit`; their fields are described in the JSON Schema of the tool.',
    '',
    '| Command | Fields | Description |',
    '| --- | --- | --- |',
    ...commands,
    '',
    END,
  ].join('\n');
}

/** The document with its catalogue section regenerated and the whole file formatted like the repository. */
export async function withCatalogue(document: string, filename = CATALOGUE_DOCUMENT): Promise<string> {
  const start = document.indexOf(START);
  const end = document.indexOf(END);
  if (start < 0 || end < start) throw new Error(`${filename} has no operation catalogue markers.`);
  const next = document.slice(0, start) + operationCatalogue() + document.slice(end + END.length);
  return format(next, { ...(await resolveConfig(filename)), filepath: filename });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await writeFile(CATALOGUE_DOCUMENT, await withCatalogue(await readFile(CATALOGUE_DOCUMENT, 'utf8')));
}
