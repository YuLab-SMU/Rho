import { pathToFileURL } from 'node:url';

type Operation = { id: string; inputSchema: Record<string, any> };
type RuntimeResult = {
  host: 'passed' | 'failed';
  operations: { id: string; state: 'passed' | 'failed'; error?: string }[];
};

function sample(schema: Record<string, any>): any {
  if (schema.oneOf?.length) return sample(schema.oneOf[0]);
  if (schema.anyOf?.length) return sample(schema.anyOf[0]);
  if (schema.const !== undefined) return schema.const;
  if (schema.enum?.length) return schema.enum[0];
  if (schema.type === 'object' || schema.properties) {
    const value: Record<string, unknown> = {};
    for (const key of schema.required ?? []) value[key] = sample(schema.properties?.[key] ?? {});
    return value;
  }
  if (schema.type === 'array') return [];
  if (Array.isArray(schema.type)) return sample({ ...schema, type: schema.type.find((type: string) => type !== 'null') ?? 'string' });
  if (schema.type === 'integer' || schema.type === 'number') return schema.minimum ?? 0;
  if (schema.type === 'boolean') return false;
  return 'example';
}

const [entry, rawOperations, projectRoot] = process.argv.slice(2);
if (!entry || !rawOperations || !projectRoot) throw new Error('The plugin check worker needs an entry, operations and project root.');

try {
  const operations = JSON.parse(rawOperations) as Operation[];
  const module = await import(pathToFileURL(entry).href + '?rhoCheck=' + Date.now());
  if (typeof module.run !== 'function') throw new Error('The plugin host must export run(operation, input, context).');
  const results: RuntimeResult['operations'] = [];
  for (const operation of operations) {
    try {
      await module.run(operation.id, sample(operation.inputSchema), {
        projectRoot,
        invocationId: 'rho-plugin-check:' + operation.id,
        changeId: (label: string) => 'rho-plugin-check:' + String(label).slice(0, 40),
        call: async (method: string, body: unknown) => ({ checked: true, method, body })
      });
      results.push({ id: operation.id, state: 'passed' });
    } catch (error) {
      results.push({ id: operation.id, state: 'failed', error: error instanceof Error ? error.message : String(error) });
    }
  }
  process.stdout.write(JSON.stringify({ host: 'passed', operations: results } satisfies RuntimeResult));
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
