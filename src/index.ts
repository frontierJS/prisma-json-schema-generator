import { generatorHandler } from "@prisma/generator-helper";
import { transformDMMF } from "./generator/transformDMMF";
import * as fs from "fs";
import * as path from "path";
import { getSchema, printSchema } from "@mrleebo/prisma-ast";
import { parseEnvValue } from "@prisma/sdk";

generatorHandler({
  onManifest() {
    return {
      defaultOutput: "../.json",
      prettyName: "Frontier models JSON schemas",
    };
  },
  getDataModelDefinitions(options) {
    const { list } = getSchema(options.datamodel);

    return list.reduce((acc, item, idx, array) => {
      if (item.type !== "model") return acc;

      acc[item.name] = { __attributes: this.getAttributes({}, idx - 1, array) };

      acc[item.name].properties = (item.properties || []).reduce(
        (propAcc, field, idx, arr) => {
          if (field.type !== "field") return propAcc;

          propAcc[field.name] = {
            ...field,
            __attributes: this.getAttributes({}, idx - 1, arr),
          };
          return propAcc;
        },
        {}
      );

      return acc;
    }, {});
  },
  async onGenerate(options) {
    // console.log(options);
    this.schemaRoot = path.dirname(options.schemaPath);

    // Output Paths
    this.outputPaths = this.getOutputPaths(options);

    // Attributes Key
    const { attributesKey = "@" } = options.generator.config;
    this.attributesKey = "//" + attributesKey + " ";

    // JSON Schema from prisma-json-schema-generator
    this.jsonSchema = transformDMMF(options.dmmf, options.generator.config);

    // Datamodel definitions with comments
    const modelDefs = this.getDataModelDefinitions(options);

    // Merge fields with comments to JSON schema
    this.appendAttributesToJsonSchema(modelDefs);

    // Make any alias models needed
    this.appendAliasModelsToJsonSchema();

    // Send to outputs
    await this.sendToOutputs(options);
  },
  getOutputPaths(options) {
    return (
      (options.generator.config.outputs || "") +
      ", " +
      options.generator.output.value
    )
      .split(",")
      .filter(Boolean)
      .map((str) => str.trim());
  },
  tryParseJSON(jsonString) {
    try {
      const o = JSON.parse(jsonString);
      // Handle non-exception-throwing cases:
      // Neither JSON.parse(false) or JSON.parse(1234) throw errors, hence the type-checking,
      // but... JSON.parse(null) returns null, and typeof null === "object",
      // so we must check for that, too. Thankfully, null is falsey, so this suffices:
      if (o && typeof o === "object") {
        return o;
      } else {
        console.log("ERROR::: in db.js:", { o });
      }
    } catch (e) {
      // console.log({ e });
      return jsonString;
    }
  },
  convertToJson(text) {
    const stringifyKeys = (obj) =>
      obj.replace(/(\w+:)|(\w+ :)/g, function (matchedStr) {
        return '"' + matchedStr.substring(0, matchedStr.length - 1) + '":';
      });

    // add brackets and commas between fields
    // text =>  key:"value" json:true another:4
    //FIXME: how to handle // array:["asdfsa", (space here) "asdfasdf"]
    console.log(text);
    text = "{" + text.trim().split(" ").join(",") + "}";
    console.log(text);
    const jsonString = stringifyKeys(text);
    console.log(jsonString);

    return this.tryParseJSON(jsonString);
  },
  getAttributes(attributes, index, array) {
    const prop = array[index];
    if (!prop || prop.type !== "comment") return attributes;

    const key = this.attributesKey;
    if (!prop.text.startsWith(key)) return attributes;

    const json = this.convertToJson(prop.text.substr(key.length));
    attributes = { ...attributes, ...json };
    index--;

    return this.getAttributes(attributes, index, array);
  },
  parseFrontierMinAndMaxHelpers(attributes, field) {
    const type = Array.isArray(field.type) ? field.type[0] : field.type;
    const map = {
      "number-min": "minimum",
      "number-max": "maximum",

      "integer-min": "minimum",
      "integer-max": "maximum",

      "string-min": "minLength",
      "string-max": "maxLength",

      "array-min": "minItems",
      "array-max": "maxItems",

      "object-min": "minProperties",
      "object-max": "maxProperties",
    };

    if (attributes.min) {
      const attr = map[type + "-min"] || "min";
      field[attr] = attributes.min;
      delete attributes.min;
    }

    if (attributes.max) {
      const attr = map[type + "-max"] || "max";
      field[attr] = attributes.max;
      delete attributes.max;
    }
  },
  addMinOfZeroToIdFields(key, field) {
    if (key === "id") {
      field.minimum = 0;
    }
  },
  processExtraSchemaValues(model, key, value, prismaModelProps) {
    let field = model.properties[key];
    const { __attributes, ...prismaProps } = prismaModelProps;

    this.addMinOfZeroToIdFields(key, field);
    this.parseFrontierMinAndMaxHelpers(__attributes, field);

    field = {
      ...field,
      ...__attributes,
    };

    // Add default attribute to schema
    const defaultAttr = (prismaModelProps.attributes || []).find(
      (attr) => attr.name === "default"
    );
    if (
      defaultAttr &&
      defaultAttr.args &&
      defaultAttr.args.length &&
      typeof defaultAttr.args[0].value === "string"
    ) {
      field.default = defaultAttr.args[0].value;
    }

    model.properties[key] = field;
  },
  appendAttributesToJsonSchema(modelDefs) {
    Object.entries(modelDefs).forEach(
      ([name, { __attributes, properties }]) => {
        const model = this.jsonSchema.definitions[name];
        model.__attributes = __attributes;
        Object.entries(model.properties).forEach(([key, value]) => {
          this.processExtraSchemaValues(model, key, value, properties[key]);
        });
      }
    );
  },
  appendAliasModelsToJsonSchema() {
    Object.entries(this.jsonSchema.definitions).forEach(([key, value]) => {
      if (value.__attributes.alias) {
        const alias = [].concat(value.__attributes.alias);
        alias.forEach((name) => {
          this.jsonSchema.definitions[name] = {
            properties: { ...value.properties },
            __attributes: { ...value.__attributes },
          };
          this.jsonSchema.definitions[name].__attributes.parent = key;
          // set on properties too
          this.jsonSchema.properties[name.toLowerCase()] = {
            $ref: "#/definitions/" + name,
          };
        });
      }
    });
  },
  async sendToOutputs(options) {
    if (!this.outputPaths.length || !options.generator.output) {
      throw new Error("No output was specified for Prisma Schema Generator");
    }

    // parse from `config.outputs` : string
    const outputDirs = this.outputPaths
      .map((outputPath) => {
        console.log("Sending schema to", outputPath);
        const matches = outputPath.matchAll(/env\('(.*)'\)/g);
        const res = [...matches];
        if (!res.length) {
          return {
            value: path.resolve(this.schemaRoot, outputPath),
          };
        }

        return {
          fromEnvVar: res[0][1],
        };
      })
      .map(parseEnvValue);

    try {
      for await (const outputPath of outputDirs) {
        const outPath = path.resolve(this.schemaRoot, outputPath);
        // console.log({ outPath });
        await fs.promises.mkdir(outPath, {
          recursive: true,
        });
        await fs.promises.writeFile(
          path.join(
            outPath,
            options.generator.config.fileName || "models-schema.json"
          ),
          JSON.stringify(this.jsonSchema, null, 2)
        );
      }
      // TODO : get client path and add modelDefs there as well
    } catch (e) {
      console.error("Error: unable to write files for Prisma Schema Generator");
      throw e;
    }
  },
});
