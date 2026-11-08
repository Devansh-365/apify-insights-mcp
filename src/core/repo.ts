import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Maps actor names to local source folders, so an answer can point at the code to change.
 * Each configured dir holds one actor per subfolder; the name comes from `.actor/actor.json`,
 * falling back to the folder name.
 */
export async function scanActorDirs(dirs: string[]): Promise<Map<string, string>> {
    const byName = new Map<string, string>();
    for (const dir of dirs) {
        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        await Promise.all(
            entries
                .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
                .map(async (entry) => {
                    const path = join(dir, entry.name);
                    let name = entry.name;
                    try {
                        const manifest = JSON.parse(await readFile(join(path, '.actor', 'actor.json'), 'utf8')) as { name?: unknown };
                        if (typeof manifest.name === 'string' && manifest.name) name = manifest.name;
                    } catch {
                        return; // Not an actor folder.
                    }
                    if (!byName.has(name)) byName.set(name, path);
                }),
        );
    }
    return byName;
}
