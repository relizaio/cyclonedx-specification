"use strict";

/**
 * validate the pre-defined perspectives registry.
 * call the script via `node -- <this-file>`
 *
 * The registry is not tied to a CycloneDX version: it lives at the schema root
 * (schema/perspectives-defs.json) and is governed by schema/perspectives-defs.schema.json,
 * whose `preDefinedPerspectivesEnum` is referenced by the versioned perspective schema.
 * The data file is maintained by hand (no generator), so this test asserts:
 *  - the data file validates against its governing schema
 *  - the hand-maintained enum and the data entries are the same set, without duplicates
 *  - every entry points into the perspectives/ catalog directory; an existing catalog
 *    document must be a JSON document with an integer `version` (the value referenced
 *    by `predefinedVersion`) and must not itself declare a `predefined` identity
 */

import {readFile, stat} from 'node:fs/promises'
import {dirname, join, normalize, sep} from 'node:path'
import {fileURLToPath} from 'node:url'

import Ajv2020 from "ajv/dist/2020.js"
import draft7MetaSchema from "ajv/dist/refs/json-schema-draft-07.json" with {type: "json"};
import addFormats from 'ajv-formats'


const _thisDir = dirname(fileURLToPath(import.meta.url))

// region config

const repoRootDir = join(_thisDir, '..', '..', '..', '..', '..')
const schemaRootDir = join(repoRootDir, 'schema')
const registrySchemaFile = join(schemaRootDir, 'perspectives-defs.schema.json')
const registryDataFile = join(schemaRootDir, 'perspectives-defs.json')
const catalogDir = 'perspectives'
const enumPointer = ['definitions', 'preDefinedPerspectivesEnum', 'enum']

for (const file of [registrySchemaFile, registryDataFile]) {
    if (!await stat(file).then(s => s.isFile()).catch(() => false)) {
        throw new Error(`missing file: ${file}`);
    }
}
console.debug('DEBUG | registrySchemaFile = ', registrySchemaFile);
console.debug('DEBUG | registryDataFile = ', registryDataFile);

// endregion config

const [registrySchema, registryData] = await Promise.all([
    readFile(registrySchemaFile, 'utf-8').then(JSON.parse),
    readFile(registryDataFile, 'utf-8').then(JSON.parse),
])

let errCnt = 0

/**
 * @param {string} message
 * @param {...*} details
 */
function fail(message, ...details) {
    ++errCnt
    console.error('!!! ERROR:', message, ...details)
}

// region schema conformance

console.log('\n> validate registry data against its governing schema ...')
{
    // same strict setup as the schema validation tests
    const ajv = new Ajv2020({
        verbose: true,
        addUsedSchema: false,
        strict: true,
        strictSchema: true,
        strictNumbers: true,
        strictTypes: true,
        strictTuples: true,
        strictRequired: true,
        validateFormats: true,
    });
    // the registry schema is draft-07
    ajv.addMetaSchema(draft7MetaSchema);
    addFormats(ajv)
    let validate
    try {
        validate = ajv.compile(registrySchema)
    } catch (err) {
        fail('failed compiling registry schema', '\n  in file:', `file://${registrySchemaFile}`, '\n    error:', String(err))
    }
    if (validate !== undefined) {
        if (validate(registryData)) {
            console.log('OK.')
        } else {
            fail('registry data does not conform to its governing schema',
                '\n  for file:', `file://${registryDataFile}`,
                '\n     error:', validate.errors)
        }
    }
}

// endregion schema conformance

// region enum <-> data consistency

console.log('\n> compare governing-schema enum with registry data entries ...')
{
    const enumValues = enumPointer.reduce((node, key) => node?.[key], registrySchema)
    if (!Array.isArray(enumValues)) {
        fail(`missing enum at /${enumPointer.join('/')}`, '\n  in file:', `file://${registrySchemaFile}`)
    } else {
        const entries = Array.isArray(registryData.perspectives) ? registryData.perspectives : []
        const entryIds = entries.map(e => e?.predefined)

        const dupEnum = enumValues.filter((v, i) => enumValues.indexOf(v) !== i)
        if (dupEnum.length > 0) {
            fail('duplicate values in enum', dupEnum)
        }
        const dupIds = entryIds.filter((v, i) => entryIds.indexOf(v) !== i)
        if (dupIds.length > 0) {
            fail('duplicate `predefined` identities in registry data', dupIds)
        }

        const enumSet = new Set(enumValues)
        const idSet = new Set(entryIds)
        const enumOnly = enumValues.filter(v => !idSet.has(v))
        const dataOnly = entryIds.filter(v => !enumSet.has(v))
        if (enumOnly.length > 0) {
            fail('enum values without a registry data entry', enumOnly,
                '\n  add an entry to', `file://${registryDataFile}`)
        }
        if (dataOnly.length > 0) {
            fail('registry data entries not listed in the enum', dataOnly,
                '\n  add them to', `file://${registrySchemaFile}`)
        }
        if (dupEnum.length === 0 && dupIds.length === 0 && enumOnly.length === 0 && dataOnly.length === 0) {
            console.log('OK.', enumValues.length, 'identities')
        }
    }
}

// endregion enum <-> data consistency

// region catalog documents

console.log('\n> check catalog documents referenced by registry entries ...')
for (const entry of (Array.isArray(registryData.perspectives) ? registryData.perspectives : [])) {
    const id = entry?.predefined
    const file = entry?.file
    console.log('\ntest', id, '->', file, '...')
    if (typeof file !== 'string') {
        // already reported by schema conformance
        continue
    }
    if (!normalize(file).startsWith(`${catalogDir}${sep}`)) {
        fail(`catalog document of ${id} is not under ${catalogDir}/`, '\n  file:', file)
        continue
    }
    const filePath = join(repoRootDir, file)
    if (!await stat(filePath).then(s => s.isFile()).catch(() => false)) {
        // an identity may be reserved before its catalog document is contributed
        console.warn(`WARNING: catalog document of ${id} does not exist (yet):`, `file://${filePath}`)
        continue
    }
    let doc
    try {
        doc = JSON.parse(await readFile(filePath, 'utf-8'))
    } catch (err) {
        fail(`catalog document of ${id} is not valid JSON`, '\n  file:', `file://${filePath}`, '\n  error:', String(err))
        continue
    }
    if (!Number.isInteger(doc?.version) || doc.version < 1) {
        fail(`catalog document of ${id} must declare an integer \`version\` >= 1 (the value referenced by \`predefinedVersion\`)`,
            '\n  file:', `file://${filePath}`, '\n  version:', doc?.version)
        continue
    }
    const perspectives = Array.isArray(doc.perspectives) ? doc.perspectives : []
    if (perspectives.length === 0) {
        fail(`catalog document of ${id} defines no perspectives`, '\n  file:', `file://${filePath}`)
        continue
    }
    const withIdentity = perspectives.filter(p => p?.predefined !== undefined || p?.predefinedVersion !== undefined)
    if (withIdentity.length > 0) {
        fail(`catalog document of ${id} must define its perspective inline, not by pre-defined reference`,
            '\n  file:', `file://${filePath}`, '\n  offending:', withIdentity.map(p => p['bom-ref'] ?? p.name))
        continue
    }
    console.log('OK.', 'version', doc.version)
}

// endregion catalog documents

console.log('\n\n> found', errCnt, 'errors')
// Exit statuses should be in the range 0 to 254.
// The status 0 is used to terminate the program successfully.
process.exitCode = Math.min(errCnt, 254)
