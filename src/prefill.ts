import { log } from 'apify';
import type { Actor as ApifyActor, ApifyClient, Build } from 'apify-client';

interface InputSchemaProperty {
    prefill?: unknown;
}

interface InputSchema {
    properties?: Record<string, InputSchemaProperty>;
}

export interface ResolvedActorInput {
    input: Record<string, unknown>;
    /** Where the input came from, for reporting. */
    source: 'inputSchemaPrefill' | 'exampleRunInput' | 'empty';
    buildId: string | null;
    buildNumber: string | null;
}

/** Builds the input object from the `prefill` values of the input schema properties. */
export function prefillFromInputSchema(schema: InputSchema | null | undefined): Record<string, unknown> {
    const input: Record<string, unknown> = {};
    for (const [key, property] of Object.entries(schema?.properties ?? {})) {
        if (property?.prefill !== undefined) input[key] = property.prefill;
    }
    return input;
}

function inputSchemaFromBuild(build: Build): InputSchema | null {
    if (build.actorDefinition?.input) return build.actorDefinition.input as InputSchema;
    if (build.inputSchema) return JSON.parse(build.inputSchema) as InputSchema;
    return null;
}

async function getBuild(client: ApifyClient, actor: ApifyActor, buildTag?: string): Promise<Build | undefined> {
    const actorClient = client.actor(actor.id);
    if (buildTag) {
        const taggedBuildId = actor.taggedBuilds?.[buildTag]?.buildId;
        if (taggedBuildId) return client.build(taggedBuildId).get();
        log.warning(
            `Build tag "${buildTag}" not found on ${actor.username}/${actor.name}, using its default build for the input schema.`,
        );
    }
    return (await actorClient.defaultBuild()).get();
}

/**
 * Returns the input the Actor would get in Console when you open it and click Start without
 * changing anything, i.e. the input schema prefills. Falls back to the Actor's example run input.
 */
export async function resolvePrefilledInput(
    client: ApifyClient,
    actor: ApifyActor,
    buildTag?: string,
): Promise<ResolvedActorInput> {
    let build: Build | undefined;
    try {
        build = await getBuild(client, actor, buildTag);
    } catch (err) {
        log.warning(`Could not load build of ${actor.username}/${actor.name}: ${(err as Error).message}`);
    }

    const buildInfo = { buildId: build?.id ?? null, buildNumber: build?.buildNumber ?? null };
    const prefill = build ? prefillFromInputSchema(inputSchemaFromBuild(build)) : {};
    if (Object.keys(prefill).length > 0) return { input: prefill, source: 'inputSchemaPrefill', ...buildInfo };

    const example = actor.exampleRunInput;
    if (example?.body && example.contentType?.includes('json')) {
        try {
            return { input: JSON.parse(example.body), source: 'exampleRunInput', ...buildInfo };
        } catch {
            log.warning(`Example run input of ${actor.username}/${actor.name} is not valid JSON, ignoring it.`);
        }
    }
    return { input: {}, source: 'empty', ...buildInfo };
}
