import { reporter } from "io-ts-reporters";
import { normalize, relative } from "path";
import { IModule } from "../interfaces/modules";
import {
  IWebpackStats,
  IWebpackStatsAsset,
  IWebpackStatsAssets,
  IWebpackStatsChunk,
  IWebpackStatsModule,
  IWebpackStatsModuleModules,
  IWebpackStatsModules,
  IWebpackStatsModuleSource,
  IWebpackStatsModuleSynthetic,
  RWebpackStats,
  RWebpackStatsModuleModules,
  RWebpackStatsModuleSource,
  RWebpackStatsModuleSynthetic,
} from "../interfaces/webpack-stats";
import { toPosixPath } from "../util/files";
import { sort } from "../util/strings";

export interface IActionConstructor {
  stats: IWebpackStats;
}

interface IModulesByAsset {
  [asset: string]: {
    asset: IWebpackStatsAsset;
    mods: IModule[];
  };
}

// Helper structure
interface IModulesSetByAsset {
  [asset: string]: {
    asset: IWebpackStatsAsset;
    mods: Set<IModule>
  };
}

// Note: Should only use with strings from `toPosixName()`.
const NM_RE = /(^|\/)(node_modules|\~)(\/|$)/g;
export const nodeModulesParts = (name: string) => toPosixPath(name).split(NM_RE);

// True if name is part of a `node_modules` path.
export const _isNodeModules = (name: string): boolean => nodeModulesParts(name).length > 1;

// Remove all relative higher-up paths (`./` or `../../../`).
const _removePrepath = (val) => val.replace(/^(\.+(\/|\\)+)+/g, "");

// Attempt to "unwind" webpack paths in `identifier` and `name` to remove
// prefixes and produce a normal, usable filepath.
//
// First, strip off anything before a `?` and `!`:
// - `REMOVE?KEEP`
// - `REMOVE!KEEP`
export const _normalizeWebpackPath = (identifier: string, name?: string): string => {
  const bangLastIdx = identifier.lastIndexOf("!");
  const questionLastIdx = identifier.lastIndexOf("?");
  const prefixEnd = Math.max(bangLastIdx, questionLastIdx);

  let candidate = identifier;

  // Remove prefix here.
  if (prefixEnd > -1) {
    candidate = candidate.substr(prefixEnd + 1);
  }

  // Assume a normalized then truncate to name if applicable.
  //
  // E.g.,
  // - `identifier`: "css /PATH/TO/node_modules/cache-loader/dist/cjs.js!STUFF
  //   !/PATH/TO/node_modules/font-awesome/css/font-awesome.css 0"
  // - `name`: "node_modules/font-awesome/css/font-awesome.css"
  //
  // Forms of name:
  // - v1, v2: "/PATH/TO/ROOT/~/pkg/index.js"
  // - v3: "/PATH/TO/ROOT/node_modules/pkg/index.js"
  // - v4: "./node_modules/pkg/index.js"
  if (name) {
    // Expand `node_modules`, remove prefix `./`, `../`, etc.
    name = _removePrepath(name)
      .replace("/~/", "/node_modules/")
      .replace("\\~\\", "\\node_modules\\");

    // Now, truncate suffix of the candidate if name has less.
    const nameLastIdx = candidate.lastIndexOf(name);
    if (nameLastIdx > -1 && candidate.length !== nameLastIdx + name.length) {
      candidate = candidate.substr(0, nameLastIdx + name.length);
    }
  }

  return candidate;
};

// Convert a `node_modules` name to a base name.
//
// **Note**: Assumes only passed `node_modules` values.
//
// Normalizations:
// - Remove starting path if `./`
// - Switch Windows paths to Mac/Unix style.
export const _getBaseName = (name: string): string => {
  // Slice to just after last occurrence of node_modules.
  const parts = nodeModulesParts(name);
  const lastName = parts[parts.length - 1];

  // Normalize out the rest of the string.
  let candidate = normalize(relative(".", lastName));

  // Short-circuit on empty string / current path.
  if (candidate === ".") {
    return "";
  }

  // Special case -- synthetic modules can end up with trailing `/` because
  // of a regular expression. Preserve this.
  //
  // E.g., `/PATH/TO/node_modules/moment/locale sync /es/`
  //
  // **Note**: The rest of this tranform _should_ be safe for synthetic regexps,
  // but we can always revisit.
  if (name[name.length - 1] === "/") {
    candidate += "/";
  }

  return toPosixPath(candidate);
};

// Convert an identifier into a full path.
//
// Uses the (normalized) `name` field to assess that the (normalized) identifier
// is indeed a real file on disk.
export const _getFullPath = (identifier: string, name: string, TODO_REMOVE_OBJ: any): string => {
  const posixIdentifier = toPosixPath(identifier);

   // Start some normalization.
  let posixName = _removePrepath(toPosixPath(name));
  if (posixName.startsWith("./")) {
    // Remove dot-slash relative part.
    posixName = posixName.slice(2);
  }

  // If the name is not the end of the identifier, it probably is webpack v1-2
  // with `~` instead of `node_modules`
  const idxOfName = posixIdentifier.indexOf(posixName);
  if (idxOfName === 0) {
    // Direct match. We're done.
    return normalize(posixName);
  } else if (idxOfName === posixIdentifier.length - posixName.length) {
    // Suffix match.
    // TODO(FULL_PATH): COMBINE WITH PREVIOUS
    // TODO(FULL_PATH): Combine multiple processing fns
    return normalize(posixName);
  }
   if (identifier.lastIndexOf(name) !== identifier.length - name.length) {
    console.log("TODO MISMATCH", JSON.stringify({
      posixIdentifier,
      posixName,
      normalize: normalize(posixIdentifier),
      TODO_REMOVE_OBJ: {
        issuer: TODO_REMOVE_OBJ.issuer,
        source: TODO_REMOVE_OBJ.source || "NO_SOURCE",
      }
    }, null, 2));
  }

  // TODO: HERE -- this stuff isn't even remotely done. Above or below :).
  return "TODO";
};

export abstract class Action {
  public stats: IWebpackStats;
  private _data?: object;
  private _modules?: IModule[];
  private _assets?: IModulesByAsset;
  private _template?: ITemplate;

  constructor({ stats }: IActionConstructor) {
    this.stats = stats;
  }

  public validate(): Promise<IAction> {
    return Promise.resolve()
      .then(() => {
        // Validate the stats object.
        const result = RWebpackStats.decode(this.stats);
        if (result.isLeft()) {
          const errs = reporter(result);
          throw new Error(`Invalid webpack stats object. (Errors: ${errs.join(", ")})`);
        }
      })
      .then(() => this);
  }

  // Create the internal data object for this action.
  //
  // This is a memoizing wrapper on the abstract internal method actions
  // must implement.
  public getData(): Promise<object> {
    return Promise.resolve()
      .then(() => this._data || this._getData())
      .then((data) => this._data = data);
  }

  // Flat array of webpack source modules only. (Memoized)
  public get modules(): IModule[] {
    return this._modules = this._modules || this.getSourceMods(this.stats.modules);
  }

  protected getSourceMods(
    mods: IWebpackStatsModules,
    parentChunks?: IWebpackStatsChunk[],
  ): IModule[] {
    return mods
      // Recursively flatten to list of source modules.
      .reduce(
        (list: IModule[], mod: IWebpackStatsModule) => {
          // Add in any parent chunks and ensure unique array.
          const chunks = Array.from(new Set(mod.chunks.concat(parentChunks || [])));

          // Fields
          let isSynthetic = false;
          let source = null;
          let identifier;
          let name;
          let size;

          if (RWebpackStatsModuleModules.decode(mod).isRight()) {
            // Recursive case -- more modules.
            const modsMod = mod as IWebpackStatsModuleModules;

            // Return and recurse.
            return list.concat(this.getSourceMods(modsMod.modules, chunks));

          } else if (RWebpackStatsModuleSource.decode(mod).isRight()) {
            // Easy case -- a normal source code module.
            const srcMod = mod as IWebpackStatsModuleSource;
            identifier = srcMod.identifier;
            name = srcMod.name;
            size = srcMod.size;
            source = srcMod.source;

          } else if (RWebpackStatsModuleSynthetic.decode(mod).isRight()) {
            // Catch-all case -- a module without modules or source.
            const syntheticMod = mod as IWebpackStatsModuleSynthetic;
            identifier = syntheticMod.identifier;
            name = syntheticMod.name;
            size = syntheticMod.size;
            isSynthetic = true;

          } else {
            throw new Error(`Cannot match to known module type: ${JSON.stringify(mod)}`);
          }

          // We've now got a single entry to prepare and add.
          const normalizedName = _normalizeWebpackPath(name);
          const normalizedId = _normalizeWebpackPath(identifier, normalizedName);
          const isNodeModules = _isNodeModules(normalizedId);
          const baseName = isNodeModules ? _getBaseName(normalizedId) : null;

          // TODO(FULL_PATH): Add into data
          _getFullPath(normalizedId, normalizedName, mod);

          return list.concat([{
            baseName,
            chunks,
            identifier,
            isNodeModules,
            isSynthetic,
            size,
            source,
          }]);
        },
        [],
      )
      // Sort: via https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String/localeCompare
      .sort((a, b) => a.identifier.localeCompare(b.identifier));
  }

  // Object of source modules grouped by asset. (Memoized)
  public get assets(): IModulesByAsset {
    return this._assets = this._assets || this.getSourceAssets(this.stats.assets);
  }

  protected getSourceAssets(assets: IWebpackStatsAssets): IModulesByAsset {
    // Helper: LUT from chunk to asset name.
    const chunksToAssets: { [chunk: string]: Set<string> } = {};
    // Actual working data object.
    const modulesSetByAsset: IModulesSetByAsset = {};

    // Limit assets to possible JS files.
    const jsAssets = assets.filter((asset) => /\.(m|)js$/.test(asset.name));

    // Iterate assets and begin populating structures.
    jsAssets.forEach((asset) => {
      modulesSetByAsset[asset.name] = {
        asset,
        mods: new Set(),
      };

      asset.chunks.forEach((chunk) => {
        chunk = chunk.toString(); // force to string.
        chunksToAssets[chunk] = chunksToAssets[chunk] || new Set();

        // Add unique assets.
        chunksToAssets[chunk].add(asset.name);
      });
    });

    // Iterate modules and attach as appropriate.
    this.modules.forEach((mod) => {
      mod.chunks.forEach((chunk) => {
        chunk = chunk.toString(); // force to string.
        (chunksToAssets[chunk] || []).forEach((assetName) => {
          const assetObj = modulesSetByAsset[assetName];
          if (assetObj) {
            assetObj.mods.add(mod);
          }
        });
      });
    });

    // Convert to final form
    return Object.keys(modulesSetByAsset)
      .sort(sort)
      .reduce((memo: IModulesByAsset, assetName) => {
        const assetSetObj = modulesSetByAsset[assetName];
        memo[assetName] = {
          asset: assetSetObj.asset,
          mods: Array.from(assetSetObj.mods),
        };
        return memo;
      }, {});
  }

  public get template(): ITemplate {
    this._template = this._template || this._createTemplate();
    return this._template;
  }

  protected abstract _getData(): Promise<object>;
  protected abstract _createTemplate(): ITemplate;
}

// Simple alias for now (may extend later as real interface).
export type IAction = Action;

interface ITemplateConstructor {
  action: IAction;
}

export enum TemplateFormat {
  json = "json",
  text = "text",
  tsv = "tsv",
}

export interface ITemplate {
  json(): Promise<string>;
  text(): Promise<string>;
  tsv(): Promise<string>;
  render(format: TemplateFormat): Promise<string>;
}

export abstract class Template implements ITemplate {
  protected action: IAction;

  constructor({ action }: ITemplateConstructor) {
    this.action = action;
  }

  public json(): Promise<string> {
    return this.action.getData().then((data) => JSON.stringify(data, null, 2));
  }

  public abstract text(): Promise<string>;
  public abstract tsv(): Promise<string>;

  public render(format: TemplateFormat): Promise<string> {
    return this[format]();
  }

  protected trim(str: string, num: number) {
    return str
      .trimRight() // trailing space.
      .replace(/^[ ]*\s*/m, "") // First line, if empty.
      .replace(new RegExp(`^[ ]{${num}}`, "gm"), "");
  }
}
