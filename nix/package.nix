{
  lib,
  buildNpmPackage,
  nodejs_24,
  jq,
}:

let
  packageJson = lib.importJSON ../package.json;
in
buildNpmPackage {
  pname = "oai-image";
  inherit (packageJson) version;

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../package.json
      ../package-lock.json
      ../tsconfig.json
      ../tsconfig.build.json
      ../src
      ../test
      ../README.md
      ../LICENSE
    ];
  };

  nodejs = nodejs_24;

  # `bun` is only a dev dependency for `npm run build:binary`. It pulls in a
  # ~100 MB native runtime per platform, so drop it (and its @oven/* platform
  # packages) from the lockfile before the dependencies are fetched. The same
  # postPatch runs for fetchNpmDeps, so the hash covers the trimmed lockfile.
  nativeBuildInputs = [ jq ];
  postPatch = ''
    ${lib.getExe jq} 'del(.devDependencies.bun)' package.json > package.json.tmp
    mv package.json.tmp package.json
    ${lib.getExe jq} '
      del(.packages[""].devDependencies.bun)
      | .packages |= with_entries(select(.key | test("^node_modules/(bun|@oven/)") | not))
    ' package-lock.json > package-lock.json.tmp
    mv package-lock.json.tmp package-lock.json
  '';

  npmDepsHash = "sha256-SXCYw/3j6xeHM8cDWZHjJX7KOlAbQKzBo4GQyVJnA6A=";

  doCheck = true;
  checkPhase = ''
    runHook preCheck
    npm test
    runHook postCheck
  '';

  meta = {
    description = packageJson.description;
    homepage = "https://github.com/thehumanworks/oai-image";
    license = lib.licenses.mit;
    mainProgram = "oai-image";
    platforms = lib.platforms.unix;
  };
}
