import { createHash } from "node:crypto";
import { dirname, extname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { uneval } from "devalue";
import MagicString, { type SourceMap } from "magic-string";
import { parseSync } from "rolldown/utils";

const DEFAULT_TIMEOUT = 10_000;
const PACKAGE_NAME = "comptime";
const RUNTIME_ERROR = "comptime() must be replaced by the Vite or Rolldown plugin before runtime";
const RUNTIME_VIRTUAL_ID = "\0comptime:runtime";
const RUNTIME_VIRTUAL_MODULE = `export function comptime() { throw new Error(${JSON.stringify(RUNTIME_ERROR)}); }\n`;
const SUPPORTED_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
]);
const SKIPPED_CHILD_KEYS = new Set([
  "typeAnnotation",
  "returnType",
  "typeParameters",
  "typeArguments",
]);

export type Evaluator = {
  evaluate(virtualId: string, body: string, origin: string): Promise<unknown>;
  dispose(): Promise<void>;
};

export type CustomSerializer = {
  test(value: unknown): boolean;
  serialize(value: unknown): string;
};

export type ComptimeOptions = {
  include?: string | string[];
  exclude?: string | string[];
  timeout?: number;
  env?: string[] | "all" | "declared";
  customSerializers?: CustomSerializer[];
};

export type TransformResult = {
  code: string;
  map: SourceMap;
};

export type TransformContext = {
  addWatchFile?(id: string): void;
};

export type ComptimeCore = {
  resolveId(id: string): string | null;
  load(id: string): string | null;
  transform(code: string, id: string, context?: TransformContext): Promise<TransformResult | null>;
  invalidate(id?: string): void;
};

export type CreateCoreOptions = {
  getEvaluator(): Evaluator;
  options?: ComptimeOptions;
};

export type SourceLocation = {
  file: string;
  line: number;
  column: number;
};

type ErrorInput = {
  message: string;
  id: string;
  code: string;
  start: number;
  cause?: unknown;
};

export class ComptimeTransformError extends Error {
  readonly id: string;
  readonly loc: SourceLocation;
  readonly frame: string;
  override readonly cause?: unknown;

  constructor(input: ErrorInput) {
    super(input.message);
    this.name = "ComptimeTransformError";
    this.id = input.id;
    this.loc = locate(input.code, input.id, input.start);
    this.frame = createFrame(input.code, this.loc.line, this.loc.column);
    this.cause = input.cause;
  }
}

type AstNode = {
  type: string;
  start?: number;
  end?: number;
} & Record<string, unknown>;

type ImportBinding = {
  localName: string;
  statement: string;
  moduleRequest: string;
};

type ImportName = {
  kind: string;
  name?: string | null;
};

type ValueSpan = {
  value: string;
};

type StaticImportEntryLike = {
  importName: ImportName;
  localName: ValueSpan;
  isType: boolean;
};

type StaticImportLike = {
  moduleRequest: ValueSpan;
  entries: StaticImportEntryLike[];
};

type RawCall = {
  node: AstNode;
  fn: AstNode;
  start: number;
  end: number;
  index: number;
};

type NormalizedOptions = {
  include: string[] | undefined;
  exclude: string[] | undefined;
  timeout: number;
  env: string[] | "all" | "declared";
  customSerializers: CustomSerializer[];
};

type EnvReads = {
  keys: Set<string>;
  dynamic: boolean;
};

type Declaration = {
  names: Set<string>;
  refs: Set<string>;
  source: string;
  start: number;
  end: number;
};

export function createCore(input: CreateCoreOptions): ComptimeCore {
  let options = normalizeOptions(input.options);
  let virtualModules = new Map<string, string>();
  let cache = new Map<string, string>();

  return {
    resolveId(id) {
      if (id === PACKAGE_NAME) {
        return RUNTIME_VIRTUAL_ID;
      }
      return virtualModules.has(id) ? id : null;
    },

    load(id) {
      if (id === RUNTIME_VIRTUAL_ID) {
        return RUNTIME_VIRTUAL_MODULE;
      }
      return virtualModules.get(id) ?? null;
    },

    async transform(code, id, context) {
      if (!shouldScan(id, code, options)) {
        return null;
      }

      let parseResult = parseSync(id, code, {
        astType: "ts",
        sourceType: "module",
      });
      let parseError = parseResult.errors.find((error) => error.severity === "Error");
      if (parseError) {
        throw new ComptimeTransformError({
          message: parseError.message,
          id,
          code,
          start: parseError.labels[0]?.start ?? 0,
          cause: parseError,
        });
      }

      let comptimeBindings = collectComptimeBindings(parseResult.module.staticImports);
      if (comptimeBindings.size === 0) {
        return null;
      }

      let calls = findComptimeCalls(parseResult.program, comptimeBindings);
      if (calls.length === 0) {
        return null;
      }

      let imports = collectImportBindings(parseResult.module.staticImports, id, comptimeBindings);
      let declarations = collectTopLevelDeclarations(parseResult.program, code);
      let edited = new MagicString(code);

      for (let call of calls) {
        let fnInfo = getFunctionInfo(call.fn, code, id);
        if (!fnInfo.valid) {
          throw new ComptimeTransformError({
            message: "comptime() requires a single arrow function with no parameters",
            id,
            code,
            start: call.start,
          });
        }

        let refs = collectIdentifierReferences(fnInfo.bodyNode);
        let capturedImports = createImportStatements(imports, refs);
        let capturedDeclarations = createDeclarationStatements(
          declarations,
          refs,
          call.start,
          call.end,
        );
        let envReads = collectEnvReads(fnInfo.bodyNode);
        enforceEnvPolicy(envReads, options, code, id, call.start);

        for (let captured of capturedImports.watchFiles) {
          context?.addWatchFile?.(captured);
        }

        let virtualId = `\0comptime:${stripQuery(id)}:${call.index}`;
        let moduleBody = createVirtualModule(
          capturedImports.statements,
          capturedDeclarations,
          fnInfo.body,
        );
        virtualModules.set(virtualId, moduleBody);

        let cacheKey = createCacheKey(moduleBody, envReads);
        let literal = cache.get(cacheKey);
        if (literal === undefined) {
          try {
            var value = await withTimeout(
              input.getEvaluator().evaluate(virtualId, moduleBody, id),
              options.timeout,
            );
          } catch (error) {
            throw wrapEvaluationError(error, code, id, call.start, options.timeout);
          }

          try {
            literal = serializeValue(value, options);
          } catch (error) {
            throw new ComptimeTransformError({
              message: `comptime returned a value that cannot be serialized: ${messageFrom(error)}`,
              id,
              code,
              start: call.start,
              cause: error,
            });
          }
          cache.set(cacheKey, literal);
        }

        edited.overwrite(call.start, call.end, literal);
      }

      return {
        code: edited.toString(),
        map: edited.generateMap({ hires: true, source: id }),
      };
    },

    invalidate() {
      cache.clear();
    },
  };
}

function normalizeOptions(options: ComptimeOptions | undefined): NormalizedOptions {
  return {
    include: normalizePatterns(options?.include),
    exclude: normalizePatterns(options?.exclude),
    timeout: options?.timeout ?? DEFAULT_TIMEOUT,
    env: options?.env ?? "all",
    customSerializers: options?.customSerializers ?? [],
  };
}

function normalizePatterns(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  return Array.isArray(value) ? value : [value];
}

function shouldScan(id: string, code: string, options: NormalizedOptions): boolean {
  if (!code.includes(PACKAGE_NAME)) {
    return false;
  }

  let cleanId = stripQuery(id);
  if (!SUPPORTED_EXTENSIONS.has(extname(cleanId))) {
    return false;
  }

  if (options.include && !matchesAny(cleanId, options.include)) {
    return false;
  }

  if (options.exclude && matchesAny(cleanId, options.exclude)) {
    return false;
  }

  return true;
}

function matchesAny(value: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesPattern(value, pattern));
}

function matchesPattern(value: string, pattern: string): boolean {
  if (!pattern.includes("*")) {
    return value.includes(pattern);
  }

  let escaped = pattern
    .replaceAll("\\", "\\\\")
    .replaceAll(".", "\\.")
    .replaceAll("+", "\\+")
    .replaceAll("?", "\\?")
    .replaceAll("^", "\\^")
    .replaceAll("$", "\\$")
    .replaceAll("{", "\\{")
    .replaceAll("}", "\\}")
    .replaceAll("(", "\\(")
    .replaceAll(")", "\\)")
    .replaceAll("|", "\\|")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]")
    .replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

function collectComptimeBindings(imports: StaticImportLike[]): Set<string> {
  let names = new Set<string>();
  for (let item of imports) {
    if (item.moduleRequest.value !== PACKAGE_NAME) {
      continue;
    }
    for (let entry of item.entries) {
      if (entry.isType) {
        continue;
      }
      if (entry.importName.kind === "Name" && entry.importName.name === "comptime") {
        names.add(entry.localName.value);
      }
    }
  }
  return names;
}

function collectImportBindings(
  imports: StaticImportLike[],
  origin: string,
  comptimeBindings: Set<string>,
): Map<string, ImportBinding> {
  let result = new Map<string, ImportBinding>();
  for (let item of imports) {
    if (item.moduleRequest.value === PACKAGE_NAME) {
      continue;
    }

    for (let entry of item.entries) {
      if (entry.isType || comptimeBindings.has(entry.localName.value)) {
        continue;
      }
      result.set(entry.localName.value, {
        localName: entry.localName.value,
        statement: createImportStatement(entry, resolveImport(item.moduleRequest.value, origin)),
        moduleRequest: resolveImport(item.moduleRequest.value, origin),
      });
    }
  }
  return result;
}

function createImportStatement(entry: StaticImportEntryLike, moduleRequest: string): string {
  let specifier: string;
  if (entry.importName.kind === "Default") {
    specifier = entry.localName.value;
  } else if (entry.importName.kind === "NamespaceObject") {
    specifier = `* as ${entry.localName.value}`;
  } else {
    let imported = entry.importName.name ?? entry.localName.value;
    specifier =
      imported === entry.localName.value
        ? `{ ${imported} }`
        : `{ ${imported} as ${entry.localName.value} }`;
  }
  return `import ${specifier} from ${JSON.stringify(moduleRequest)};`;
}

function resolveImport(specifier: string, origin: string): string {
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    let base = dirname(stripQuery(origin));
    return isAbsolute(specifier) ? specifier : resolve(base, specifier);
  }
  if (specifier.startsWith("file:")) {
    return fileURLToPath(specifier);
  }
  return specifier;
}

function findComptimeCalls(program: unknown, importedNames: Set<string>): RawCall[] {
  let calls: RawCall[] = [];
  let scopes: Array<Set<string>> = [new Set()];
  visitForCalls(program, importedNames, scopes, calls);
  return calls.map((call, index) => ({
    ...call,
    index,
  }));
}

function visitForCalls(
  value: unknown,
  importedNames: Set<string>,
  scopes: Array<Set<string>>,
  calls: RawCall[],
): void {
  if (!isAstNode(value) || value.type.startsWith("TS")) {
    return;
  }

  if (value.type === "Program" || value.type === "BlockStatement") {
    scopes.push(collectDeclarationsInContainer(value));
    visitChildren(value, (child) => visitForCalls(child, importedNames, scopes, calls));
    scopes.pop();
    return;
  }

  if (
    value.type === "FunctionDeclaration" ||
    value.type === "FunctionExpression" ||
    value.type === "ArrowFunctionExpression"
  ) {
    let scope = collectFunctionScope(value);
    scopes.push(scope);
    visitFunctionChildrenForCalls(value, importedNames, scopes, calls);
    scopes.pop();
    return;
  }

  if (value.type === "CallExpression") {
    let callee = readNode(value, "callee");
    let name = readIdentifierName(callee);
    if (name && importedNames.has(name) && !isShadowed(name, scopes)) {
      let start = readOffset(value, "start");
      let end = readOffset(value, "end");
      let args = readArray(value, "arguments");
      let firstArg = args[0];
      if (start !== undefined && end !== undefined && isAstNode(firstArg)) {
        calls.push({
          node: value,
          fn: firstArg,
          start,
          end,
          index: 0,
        });
      } else if (start !== undefined && end !== undefined) {
        calls.push({
          node: value,
          fn: value,
          start,
          end,
          index: 0,
        });
      }
    }
  }

  visitChildren(value, (child) => visitForCalls(child, importedNames, scopes, calls));
}

function visitFunctionChildrenForCalls(
  node: AstNode,
  importedNames: Set<string>,
  scopes: Array<Set<string>>,
  calls: RawCall[],
): void {
  let body = readNode(node, "body");
  if (body) {
    visitForCalls(body, importedNames, scopes, calls);
  }
}

function isShadowed(name: string, scopes: Array<Set<string>>): boolean {
  for (let index = 1; index < scopes.length; index += 1) {
    if (scopes[index]?.has(name)) {
      return true;
    }
  }
  return false;
}

function getFunctionInfo(
  fn: AstNode,
  code: string,
  id: string,
): { valid: true; body: string; bodyNode: AstNode } | { valid: false } {
  if (fn.type !== "ArrowFunctionExpression" && fn.type !== "FunctionExpression") {
    return { valid: false };
  }

  if (readArray(fn, "params").length !== 0) {
    return { valid: false };
  }

  let bodyNode = readNode(fn, "body");
  if (!bodyNode) {
    return { valid: false };
  }

  let start = readOffset(bodyNode, "start");
  let end = readOffset(bodyNode, "end");
  if (start === undefined || end === undefined) {
    throw new ComptimeTransformError({
      message: "comptime() body is missing source offsets",
      id,
      code,
      start: readOffset(fn, "start") ?? 0,
    });
  }

  if (bodyNode.type === "BlockStatement") {
    return {
      valid: true,
      body: code.slice(start + 1, end - 1),
      bodyNode,
    };
  }

  return {
    valid: true,
    body: `return ${code.slice(start, end)};`,
    bodyNode,
  };
}

function createVirtualModule(imports: string[], declarations: string[], body: string): string {
  let parts: string[] = [];
  parts.push(...imports);
  parts.push(...declarations);
  parts.push("export default await (async () => {");
  parts.push(body);
  parts.push("})();");
  return `${parts.join("\n")}\n`;
}

function createImportStatements(
  imports: Map<string, ImportBinding>,
  refs: Set<string>,
): { statements: string[]; watchFiles: string[] } {
  let statements: string[] = [];
  let watchFiles: string[] = [];
  let seen = new Set<string>();

  for (let ref of refs) {
    let binding = imports.get(ref);
    if (!binding || seen.has(binding.statement)) {
      continue;
    }
    statements.push(binding.statement);
    seen.add(binding.statement);
    if (binding.moduleRequest.startsWith("/")) {
      watchFiles.push(binding.moduleRequest);
    }
  }

  return { statements, watchFiles };
}

function collectTopLevelDeclarations(program: unknown, code: string): Declaration[] {
  if (!isAstNode(program)) {
    return [];
  }

  let body = readArray(program, "body");
  let declarations: Declaration[] = [];
  for (let item of body) {
    if (!isAstNode(item) || item.type === "ImportDeclaration") {
      continue;
    }
    let start = readOffset(item, "start");
    let end = readOffset(item, "end");
    if (start === undefined || end === undefined) {
      continue;
    }
    let names = collectStatementBindings(item);
    if (names.size === 0) {
      continue;
    }
    declarations.push({
      names,
      refs: collectIdentifierReferences(item),
      source: code.slice(start, end),
      start,
      end,
    });
  }
  return declarations;
}

function createDeclarationStatements(
  declarations: Declaration[],
  initialRefs: Set<string>,
  callStart: number,
  callEnd: number,
): string[] {
  let needed = new Set(initialRefs);
  let included = new Set<Declaration>();
  let changed = true;

  while (changed) {
    changed = false;
    for (let declaration of declarations) {
      if (included.has(declaration) || overlaps(declaration, callStart, callEnd)) {
        continue;
      }
      if (!setsIntersect(declaration.names, needed)) {
        continue;
      }
      included.add(declaration);
      for (let ref of declaration.refs) {
        needed.add(ref);
      }
      changed = true;
    }
  }

  return declarations
    .filter((declaration) => included.has(declaration))
    .map((declaration) => declaration.source);
}

function overlaps(declaration: Declaration, start: number, end: number): boolean {
  return declaration.start <= start && declaration.end >= end;
}

function setsIntersect(left: Set<string>, right: Set<string>): boolean {
  for (let item of left) {
    if (right.has(item)) {
      return true;
    }
  }
  return false;
}

function collectIdentifierReferences(root: unknown): Set<string> {
  let refs = new Set<string>();
  let scopes: Array<Set<string>> = [new Set()];
  visitForReferences(root, scopes, refs);
  return refs;
}

function visitForReferences(value: unknown, scopes: Array<Set<string>>, refs: Set<string>): void {
  if (!isAstNode(value) || value.type.startsWith("TS")) {
    return;
  }

  if (value.type === "Identifier") {
    let name = readIdentifierName(value);
    if (name && !isDeclared(name, scopes)) {
      refs.add(name);
    }
    return;
  }

  if (value.type === "Program" || value.type === "BlockStatement") {
    scopes.push(collectDeclarationsInContainer(value));
    visitChildren(value, (child) => visitForReferences(child, scopes, refs));
    scopes.pop();
    return;
  }

  if (value.type === "VariableDeclarator") {
    let init = readNode(value, "init");
    if (init) {
      visitForReferences(init, scopes, refs);
    }
    return;
  }

  if (
    value.type === "FunctionDeclaration" ||
    value.type === "FunctionExpression" ||
    value.type === "ArrowFunctionExpression"
  ) {
    let scope = collectFunctionScope(value);
    scopes.push(scope);
    let body = readNode(value, "body");
    if (body) {
      visitForReferences(body, scopes, refs);
    }
    scopes.pop();
    return;
  }

  if (value.type === "MemberExpression" || value.type === "OptionalMemberExpression") {
    let object = readNode(value, "object");
    let property = readNode(value, "property");
    if (object) {
      visitForReferences(object, scopes, refs);
    }
    if (readBoolean(value, "computed") && property) {
      visitForReferences(property, scopes, refs);
    }
    return;
  }

  if (value.type === "Property" || value.type === "PropertyDefinition") {
    let computed = readBoolean(value, "computed");
    let key = readNode(value, "key");
    let propertyValue = readNode(value, "value");
    if (computed && key) {
      visitForReferences(key, scopes, refs);
    }
    if (propertyValue) {
      visitForReferences(propertyValue, scopes, refs);
    }
    return;
  }

  if (value.type === "ImportDeclaration") {
    return;
  }

  visitChildren(value, (child) => visitForReferences(child, scopes, refs));
}

function collectDeclarationsInContainer(node: AstNode): Set<string> {
  let names = new Set<string>();
  let body = readArray(node, "body");
  for (let item of body) {
    if (!isAstNode(item)) {
      continue;
    }
    for (let name of collectStatementBindings(item)) {
      names.add(name);
    }
  }
  return names;
}

function collectStatementBindings(node: AstNode): Set<string> {
  let names = new Set<string>();

  if (node.type === "VariableDeclaration") {
    for (let declaration of readArray(node, "declarations")) {
      if (isAstNode(declaration)) {
        collectPatternBindings(readNode(declaration, "id"), names);
      }
    }
  } else if (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") {
    let id = readNode(node, "id");
    let name = readIdentifierName(id);
    if (name) {
      names.add(name);
    }
  } else if (node.type === "ExportNamedDeclaration" || node.type === "ExportDefaultDeclaration") {
    let declaration = readNode(node, "declaration");
    if (declaration) {
      for (let name of collectStatementBindings(declaration)) {
        names.add(name);
      }
    }
  }

  return names;
}

function collectFunctionScope(node: AstNode): Set<string> {
  let names = new Set<string>();
  for (let param of readArray(node, "params")) {
    collectPatternBindings(param, names);
  }
  let body = readNode(node, "body");
  if (body?.type === "BlockStatement") {
    for (let name of collectDeclarationsInContainer(body)) {
      names.add(name);
    }
  }
  return names;
}

function collectPatternBindings(value: unknown, names: Set<string>): void {
  if (!isAstNode(value)) {
    return;
  }

  if (value.type === "Identifier") {
    let name = readIdentifierName(value);
    if (name) {
      names.add(name);
    }
    return;
  }

  if (value.type === "AssignmentPattern" || value.type === "RestElement") {
    collectPatternBindings(readNode(value, "left") ?? readNode(value, "argument"), names);
    return;
  }

  if (value.type === "Property") {
    collectPatternBindings(readNode(value, "value"), names);
    return;
  }

  visitChildren(value, (child) => collectPatternBindings(child, names));
}

function isDeclared(name: string, scopes: Array<Set<string>>): boolean {
  for (let scope of scopes) {
    if (scope.has(name)) {
      return true;
    }
  }
  return false;
}

function collectEnvReads(root: unknown): EnvReads {
  let reads: EnvReads = { keys: new Set(), dynamic: false };
  visitForEnv(root, reads);
  return reads;
}

function visitForEnv(value: unknown, reads: EnvReads): void {
  if (!isAstNode(value) || value.type.startsWith("TS")) {
    return;
  }

  if (value.type === "MemberExpression" || value.type === "OptionalMemberExpression") {
    let object = readNode(value, "object");
    let property = readNode(value, "property");
    if (isProcessEnv(object)) {
      let key = readEnvKey(value, property);
      if (key === undefined) {
        reads.dynamic = true;
      } else {
        reads.keys.add(key);
      }
      return;
    }
  }

  visitChildren(value, (child) => visitForEnv(child, reads));
}

function isProcessEnv(value: unknown): boolean {
  if (!isAstNode(value)) {
    return false;
  }
  if (value.type !== "MemberExpression" && value.type !== "OptionalMemberExpression") {
    return false;
  }
  let object = readNode(value, "object");
  let property = readNode(value, "property");
  return readIdentifierName(object) === "process" && readIdentifierName(property) === "env";
}

function readEnvKey(member: AstNode, property: AstNode | undefined): string | undefined {
  if (!property) {
    return undefined;
  }
  if (!readBoolean(member, "computed")) {
    return readIdentifierName(property);
  }
  if (property.type === "Literal") {
    let value = property.value;
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

function enforceEnvPolicy(
  reads: EnvReads,
  options: NormalizedOptions,
  code: string,
  id: string,
  start: number,
): void {
  if (options.env === "all") {
    return;
  }

  if (reads.dynamic) {
    throw new ComptimeTransformError({
      message: "comptime body reads process.env dynamically, but env is restricted",
      id,
      code,
      start,
    });
  }

  if (options.env === "declared") {
    return;
  }

  for (let key of reads.keys) {
    if (!options.env.includes(key)) {
      throw new ComptimeTransformError({
        message: `comptime body reads process.env.${key}, which is not allowed by env`,
        id,
        code,
        start,
      });
    }
  }
}

function createCacheKey(moduleBody: string, reads: EnvReads): string {
  let hash = createHash("sha256");
  hash.update(moduleBody);
  hash.update("\0env\0");
  if (reads.dynamic) {
    let envEntries = Object.entries(process.env).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    hash.update(JSON.stringify(envEntries));
  } else {
    let envEntries = Array.from(reads.keys)
      .sort()
      .map((key) => [key, process.env[key] ?? null]);
    hash.update(JSON.stringify(envEntries));
  }
  return hash.digest("hex");
}

function serializeValue(value: unknown, options: NormalizedOptions): string {
  for (let serializer of options.customSerializers) {
    if (serializer.test(value)) {
      return serializer.serialize(value);
    }
  }
  return uneval(value);
}

async function withTimeout<T>(promise: Promise<T>, timeout: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`comptime evaluation timed out after ${timeout}ms`));
    }, timeout);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function wrapEvaluationError(
  error: unknown,
  code: string,
  id: string,
  start: number,
  timeout: number,
): ComptimeTransformError {
  let message = messageFrom(error);
  if (message === `comptime evaluation timed out after ${timeout}ms`) {
    return new ComptimeTransformError({
      message,
      id,
      code,
      start,
      cause: error,
    });
  }
  return new ComptimeTransformError({
    message: `comptime evaluation threw: ${message}`,
    id,
    code,
    start,
    cause: error,
  });
}

function messageFrom(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function locate(code: string, file: string, start: number): SourceLocation {
  let line = 1;
  let column = 0;
  for (let index = 0; index < start; index += 1) {
    if (code[index] === "\n") {
      line += 1;
      column = 0;
    } else {
      column += 1;
    }
  }
  return { file, line, column };
}

function createFrame(code: string, line: number, column: number): string {
  let lines = code.split("\n");
  let source = lines[line - 1] ?? "";
  return `${line} | ${source}\n${" ".repeat(String(line).length + 3 + column)}^`;
}

function visitChildren(node: AstNode, visit: (child: unknown) => void): void {
  let keys = Object.keys(node);
  for (let key of keys) {
    if (SKIPPED_CHILD_KEYS.has(key) || key === "type" || key === "start" || key === "end") {
      continue;
    }
    let value = node[key];
    if (Array.isArray(value)) {
      for (let child of value) {
        visit(child);
      }
    } else {
      visit(value);
    }
  }
}

function readArray(node: AstNode, key: string): unknown[] {
  let value = node[key];
  return Array.isArray(value) ? value : [];
}

function readNode(node: AstNode | undefined, key: string): AstNode | undefined {
  if (!node) {
    return undefined;
  }
  let value = node[key];
  return isAstNode(value) ? value : undefined;
}

function readIdentifierName(node: unknown): string | undefined {
  if (!isAstNode(node) || node.type !== "Identifier") {
    return undefined;
  }
  let name = node.name;
  return typeof name === "string" ? name : undefined;
}

function readOffset(node: AstNode, key: "start" | "end"): number | undefined {
  let value = node[key];
  return typeof value === "number" ? value : undefined;
}

function readBoolean(node: AstNode, key: string): boolean {
  return node[key] === true;
}

function isAstNode(value: unknown): value is AstNode {
  return isRecord(value) && typeof value.type === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stripQuery(id: string): string {
  return id.split("?")[0] ?? id;
}
