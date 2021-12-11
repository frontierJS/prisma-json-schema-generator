import { generatorHandler } from "@prisma/generator-helper";
import { transformDMMF } from "./generator/transformDMMF";
import * as fs from "fs";
import * as path from "path";
import { getSchema, printSchema } from "@mrleebo/prisma-ast";
import { parseEnvValue } from "@prisma/sdk";

generatorHandler({
  onManifest() {
    return {
      defaultOutput: "./.json",
      prettyName: "Prisma JSON Schema Generator Extended",
    };
  },
  convertToJson(text) {
    const stringifyKeys = (obj) =>
      obj.replace(/(\w+:)|(\w+ :)/g, function (matchedStr) {
        return '"' + matchedStr.substring(0, matchedStr.length - 1) + '":';
      });

    // add brackets and commas between fields
    // text =>  key:"value" json:true another:4
    text = "{" + text.trim().split(" ").join(",") + "}";
    const jsonString = stringifyKeys(text);

    return JSON.parse(jsonString);
  },
  getMeta(meta, index, array) {
    const prop = array[index];
    if (!prop || prop.type !== "comment") return meta;

    const key = this.metaKey;
    // console.log('key', key)
    if (!prop.text.startsWith(key)) return meta;

    const json = this.convertToJson(prop.text.substr(key.length));
    meta = { ...meta, ...json };
    index--;

    return this.getMeta(meta, index, array);
  },
  appendMeta(modelDefs, jsonSchema) {
    Object.entries(modelDefs).forEach(([name, { properties }]) => {
      const schema = jsonSchema.definitions[name].properties;
      Object.entries(properties).forEach(([key, value]) => {
        schema[key] = {
          ...schema[key],
          ...value.__meta,
        };
      });
    });
  },
  async onGenerate(options) {
    // console.log(options)
    const schemaRoot = path.dirname(options.schemaPath);

    const outputPaths = (
      (options.generator.config.outputs || "") +
      ", " +
      options.generator.output.value
    )
      .split(",")
      .filter(Boolean)
      .map((str) => str.trim());
    // get parsed datamodel with comments
    const { list } = getSchema(options.datamodel);
    const { metaKey = "meta" } = options.generator.config;
    this.metaKey = "// " + metaKey + ": ";

    const modelDefs = list.reduce((acc, item, idx, array) => {
      if (item.type !== "model") return acc;

      acc[item.name] = { __meta: this.getMeta({}, idx - 1, array) };

      acc[item.name].properties = (item.properties || []).reduce(
        (propAcc, field, idx, arr) => {
          if (field.type !== "field") return propAcc;

          propAcc[field.name] = {
            ...field,
            __meta: this.getMeta({}, idx - 1, arr),
          };
          return propAcc;
        },
        {}
      );

      return acc;
    }, {});

    const jsonSchema = transformDMMF(options.dmmf, options.generator.config);
    this.appendMeta(modelDefs, jsonSchema);

    if (!outputPaths.length || !options.generator.output) {
      throw new Error("No output was specified for Prisma Schema Generator");
    }

    if (options.generator.output) {
      outputPaths.push(options.generator.output.value);
    }
    // parse from `config.outputs` : string
    const outputDirs = outputPaths
      .map((outputPath) => {
        const matches = outputPath.matchAll(/env\((.*)\)/g);
        const res = [...matches];
        if (!res.length) {
          return {
            value: path.resolve(schemaRoot, outputPath),
          };
        }

        return {
          fromEnvVar: res[0][1],
        };
      })
      .map(parseEnvValue);

    try {
      for await (const outputPath of outputDirs) {
        await fs.promises.mkdir(outputPath, {
          recursive: true,
        });
        await fs.promises.writeFile(
          path.join(outputPath, "json-schema.json"),
          JSON.stringify(jsonSchema, null, 2)
        );
      }
    } catch (e) {
      console.error("Error: unable to write files for Prisma Schema Generator");
      throw e;
    }
  },
});
