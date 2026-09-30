import { readFile, writeFile, readdir, mkdir } from "fs/promises";
import { extname } from "path";
import { createHash } from "crypto";

import { rollup } from "rollup";
import esbuild from "rollup-plugin-esbuild";
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
    nodeResolve(),
    commonjs(),

    {
        name: "swc",

        async transform(code, id) {
            const ext = extname(id);

            if (!extensions.includes(ext)) {
                return null;
            }

            const ts = ext.includes("ts");
            const tsx = ts ? ext.endsWith("x") : undefined;
            const jsx = !ts ? ext.endsWith("x") : undefined;

            const result = await swc.transform(code, {
                filename: id,

                jsc: {
                    externalHelpers: true,

                    parser: {
                        syntax: ts ? "typescript" : "ecmascript",
                        tsx,
                        jsx,
                    },
                },

                env: {
                    targets: "defaults",

                    include: [
                        "transform-classes",
                        "transform-arrow-functions",
                    ],
                },
            });

            return result.code;
        },
    },

    esbuild({
        minify: true,
    }),
];

const pluginsDir = "./plugins";
const distDir = "./dist";

await mkdir(distDir, {
    recursive: true,
});

for (const plug of await readdir(pluginsDir)) {
    const sourceManifestPath =
        `${pluginsDir}/${plug}/manifest.json`;

    const manifest = JSON.parse(
        await readFile(sourceManifestPath, "utf8"),
    );

    const outDir = `${distDir}/${plug}`;
    const outPath = `${outDir}/index.js`;

    await mkdir(outDir, {
        recursive: true,
    });

    try {
        const bundle = await rollup({
            input: `${pluginsDir}/${plug}/${manifest.main}`,

            onwarn() {},

            plugins,
        });

        await bundle.write({
            file: outPath,

            globals(id) {
                if (id.startsWith("@vendetta/")) {
                    return `vendetta.${id
                        .substring("@vendetta/".length)
                        .replace(/\//g, ".")}`;
                }

                const globals = {
                    react: "window.React",
                    "react-native": "window.ReactNative",
                };

                return globals[id] || undefined;
            },

            format: "iife",
            compact: true,
            exports: "named",
        });

        await bundle.close();

        const built = await readFile(outPath);

        manifest.hash = createHash("sha256")
            .update(built)
            .digest("hex");

        manifest.main = "index.js";

        await writeFile(
            `${outDir}/manifest.json`,
            JSON.stringify(manifest, null, 2),
        );

        console.log(
            `Successfully built ${manifest.name}!`,
        );
    } catch (error) {
        console.error(
            `Failed to build ${manifest.name}:`,
            error,
        );

        process.exit(1);
    }
}
