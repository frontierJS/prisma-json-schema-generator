import { generatorHandler } from '@prisma/generator-helper'
import { transformDMMF } from './generator/transformDMMF'
import * as fs from 'fs'
import * as path from 'path'
import { getSchema, printSchema } from '@mrleebo/prisma-ast'
import { parseEnvValue } from '@prisma/sdk'

generatorHandler({
    onManifest() {
        return {
            defaultOutput: './json-schemax',
            prettyName: 'Prisma JSON Schema Generator Extended',
        }
    },
    convertToJson(text) {
        const stringifyKeys = (obj) =>
            obj.replace(/(\w+:)|(\w+ :)/g, function (matchedStr) {
                return (
                    '"' + matchedStr.substring(0, matchedStr.length - 1) + '":'
                )
            })

        // add brackets and commas between fields
        // text =>  key:"value" json:true another:4
        text = '{' + text.trim().split(' ').join(',') + '}'
        const jsonString = stringifyKeys(text)

        return JSON.parse(jsonString)
    },
    getMeta(meta, index, array) {
        const prop = array[index]
        if (!prop || prop.type !== 'comment') return meta

        const key = this.metaKey
        console.log('key', key)
        if (!prop.text.startsWith(key)) return meta

        const json = this.convertToJson(prop.text.substr(key.length))
        meta = { ...meta, ...json }
        index--

        return this.getMeta(meta, index, array)
    },
    appendMeta(modelDefs, jsonSchema) {
        Object.entries(modelDefs).forEach(([name, { properties }]) => {
            console.log(name, properties)
            const schema = jsonSchema.definitions[name].properties
            Object.entries(properties).forEach(([key, value]) => {
                schema[key] = {
                    ...schema[key],
                    ...value.__meta,
                }
            })
        })
    },
    async onGenerate(options) {
        // console.log('gen has config vars', options.generator)
        // get parsed datamodel with comments
        const { list } = getSchema(options.datamodel)
        const { metaKey = 'meta' } = options.generator.config
        this.metaKey = '// ' + metaKey + ': '

        const modelDefs = list.reduce((acc, item, idx, array) => {
            if (item.type !== 'model') return acc

            acc[item.name] = { __meta: this.getMeta({}, idx - 1, array) }

            acc[item.name].properties = (item.properties || []).reduce(
                (propAcc, field, idxx, arrayx) => {
                    if (field.type !== 'field') return propAcc

                    propAcc[field.name] = {
                        ...field,
                        __meta: this.getMeta({}, idxx - 1, arrayx),
                    }
                    return propAcc
                },
                {},
            )

            return acc
        }, {})

        const jsonSchema = transformDMMF(options.dmmf, options.generator.config)
        this.appendMeta(modelDefs, jsonSchema)
        console.log(JSON.stringify(jsonSchema))

        if (options.generator.output) {
            const outputDir =
                // This ensures previous version of prisma are still supported
                typeof options.generator.output === 'string'
                    ? (options.generator.output as unknown as string)
                    : // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                      parseEnvValue(options.generator.output)
            try {
                await fs.promises.mkdir(outputDir, {
                    recursive: true,
                })
                await fs.promises.writeFile(
                    path.join(outputDir, 'json-schema.json'),
                    JSON.stringify(jsonSchema, null, 2),
                )
            } catch (e) {
                console.error(
                    'Error: unable to write files for Prisma Schema Generator',
                )
                throw e
            }
        } else {
            throw new Error(
                'No output was specified for Prisma Schema Generator',
            )
        }
    },
})
