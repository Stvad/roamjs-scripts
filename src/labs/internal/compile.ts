import nearleyCompile from "./nearley";
import esbuild from "esbuild";
import fs from "fs";
import path from "path";
import appPath from "../../common/appPath";
import dotenv from "dotenv";
dotenv.config();

declare global {
  namespace NodeJS {
    interface ProcessEnv {
      NODE_ENV: "development" | "production" | "test";
    }
  }
}

export type CliArgs = {
  out?: string;
  external?: string | string[];
  include?: string | string[];
  css?: string;
  format?: esbuild.Format;
  mirror?: string;
  env?: string | string[];
  analyze?: boolean;
  max?: string;
};

// https://github.com/evanw/esbuild/issues/337#issuecomment-954633403
const importAsGlobals = (
  mapping: Record<string, string> = {}
): esbuild.Plugin => {
  const escRe = (s: string) => s.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
  const filter = new RegExp(
    Object.keys(mapping)
      .map((mod) => `^${escRe(mod)}$`)
      .join("|")
  );

  return {
    name: "global-imports",
    setup(build) {
      build.onResolve({ filter }, (args) => {
        if (!mapping[args.path]) {
          throw new Error("Unknown global: " + args.path);
        }
        return {
          path: args.path,
          namespace: "external-global",
        };
      });

      build.onLoad(
        {
          filter,
          namespace: "external-global",
        },
        async (args) => {
          const global = mapping[args.path];
          return {
            contents: `module.exports = ${global};`,
            loader: "js",
          };
        }
      );
    },
  };
};

const compile = ({
  out,
  external,
  include,
  css,
  format,
  mirror,
  env,
  analyze,
  opts = {},
}: CliArgs & { opts?: esbuild.BuildOptions }): Promise<esbuild.BuildResult> => {
  const rootDir = fs
    .readdirSync("./src", { withFileTypes: true })
    .filter((f) => f.isFile())
    .map((f) => f.name);
  const rootTs = rootDir.filter((f) => /\.ts$/.test(f));
  const rootCss = rootDir.filter((f) => /\.css$/.test(f));
  const entryTs =
    rootTs.length === 1
      ? rootTs[0]
      : ["index.ts", "main.ts"].find((f) => rootTs.includes(f));
  const entryCss =
    rootCss.length === 1
      ? rootCss[0]
      : ["index.css", "main.css"].find((f) => rootCss.includes(f));
  if (!entryTs) {
    return Promise.reject(
      `Could not find a suitable entry file in ./src directory. Found: [${rootTs.join(
        ", "
      )}]`
    );
  }
  const externalModules = (typeof external === "string"
    ? [external]
    : external || []
  ).map((e) => e.split("="));

  return esbuild
    .build({
      absWorkingDir: process.cwd(),
      entryPoints: out
        ? {
            [out]: `./src/${entryTs}`,
            ...(entryCss ? { [out]: `./src/${entryCss}` } : {}),
          }
        : [`./src/${entryTs}`, ...(entryCss ? [`./src/${entryCss}`] : [])],
      outdir: "dist",
      bundle: true,
      define: {
        "process.env.BLUEPRINT_NAMESPACE": '"bp4"',
        "process.env.NODE_ENV": `"${process.env.NODE_ENV}"`,
        ...Object.fromEntries(
          (typeof env === "string" ? [env] : env || []).map((s) => [
            `process.env.${s}`,
            `"${process.env[s]}"`,
          ])
        ),
      },
      format,
      external: externalModules.map(([e]) => e),
      plugins: [
        {
          name: "nearley",
          setup(build) {
            build.onResolve({ filter: /\.ne$/ }, (args) => ({
              path: path.resolve(args.resolveDir, args.path),
              namespace: "nearley-ns",
            }));
            build.onLoad({ filter: /.*/, namespace: "nearley-ns" }, (args) =>
              nearleyCompile(args.path).then((contents) => ({
                contents,
                loader: "ts",
                resolveDir: path.dirname(args.path),
              }))
            );
          },
        },
        importAsGlobals(
          Object.fromEntries(externalModules.filter((e) => e.length === 2))
        ),
      ],
      metafile: analyze,
      ...opts,
    })
    .then((r) => {
      const finish = () => {
        (typeof include === "string" ? [include] : include || []).forEach(
          (f) => {
            fs.cpSync(f, path.join("dist", path.basename(f)));
          }
        );
        if (css) {
          const outCssFilename = path.join(
            "dist",
            `${css.replace(/.css$/, "")}.css`
          );
          const inputCssFiles = fs
            .readdirSync("dist")
            .filter((f) => /.css$/.test(f));

          if (inputCssFiles.length === 0) {
            console.warn("No css files in the dist/ directory");
          } else if (inputCssFiles.length === 1) {
            fs.renameSync(path.join("dist", inputCssFiles[0]), outCssFilename);
          } else {
            fs.writeFileSync(outCssFilename, "");
            inputCssFiles.forEach((f) => {
              const cssFileContent = fs
                .readFileSync(path.join("dist", f))
                .toString();
              fs.rmSync(path.join("dist", f));
              fs.appendFileSync(outCssFilename, cssFileContent);
              fs.appendFileSync(outCssFilename, "\n");
            });
          }
        }
        if (mirror) {
          if (!fs.existsSync(mirror)) fs.mkdirSync(mirror, { recursive: true });
          fs.readdirSync("dist").forEach((f) =>
            fs.cpSync(appPath(path.join(`dist`, f)), path.join(mirror, f))
          );
        }
      };
      finish();
      const { rebuild: rebuilder } = r;
      return rebuilder
        ? {
            ...r,
            rebuild: (() =>
              rebuilder()
                .then(finish)
                .then(() => rebuilder)) as esbuild.BuildInvalidate,
          }
        : r;
    });
};

export default compile;
