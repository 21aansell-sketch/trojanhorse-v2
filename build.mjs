import { readFile, writeFile, readdir, mkdir } from "fs/promises";
import { extname } from "path";
import { createHash } from "crypto";

import { rollup } from "rollup";
import commonjs from "@rollup/plugin-commonjs";
import nodeResolve from "@rollup/plugin-node-resolve";
import swc from "@swc/core";

const extensions = [
    ".js",
    ".jsx",
    ".mjs",
    ".ts",
    ".tsx",
    ".cts",
    ".mts",
];

const plugins = [
    nodeResolve({
        extensions,
        preferBuiltins: false,
    }),

    commonjs(),

    {
        name: "swc-typescript",

        async transform(code, id) {
            const ext = extname(id);

            if (!extensions.includes(ext)) {
                return null;
            }

            const isTypeScript =
                ext === ".ts" ||
                ext === ".tsx";

            const result = await swc.transform(code, {
                filename: id,

                jsc: {
                    parser: {
                        syntax: isTypeScript
                            ? "typescript"
                            : "ecmascript",

                        tsx: ext === ".tsx",
                        jsx: ext === ".jsx",
                    },

                    target: "es2020",

                    transform: {
                        react: {
                            runtime: "automatic",
                        },
                    },
                },
            });

            return {
                code: result.code,
                map: result.map,
            };
        },
    },
];

for (const plug of await readdir("./plugins")) {
    const pluginDir = `./plugins/${plug}`;
    const manifestPath = `${pluginDir}/manifest.json`;

    const manifest = JSON.parse(
        await readFile(manifestPath, "utf8"),
    );

    const outDir = `./dist/${plug}`;
    const outPath = `${outDir}/index.js`;

    await mkdir(outDir, {
        recursive: true,
    });

    const bundle = await rollup({
        input: `${pluginDir}/${manifest.main}`,

        external: (id) =>
            id.startsWith("@vendetta/") ||
            id === "react" ||
            id === "react-native",

        plugins,
    });

    await bundle.write({
        file: outPath,

        format: "iife",

        name: "plugin",

        globals: {
            react: "React",
            "react-native": "ReactNative",
        },

        sourcemap: false,
    });

    await bundle.close();

    const javascript = await readFile(outPath);

    manifest.hash = createHash("sha256")
        .update(javascript)
        .digest("hex");

    manifest.main = "index.js";

    await writeFile(
        `${outDir}/manifest.json`,
        JSON.stringify(manifest, null, 2),
    );

    console.log(
        `Built ${manifest.name}`,
    );
}
