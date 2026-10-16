{
  lib,
  buildNpmPackage,
  nodejs_24,
  autoPatchelfHook,
  makeWrapper,
  stdenv,
  procps,
  jq,
}:

let
  manifest = builtins.fromJSON (builtins.readFile ../package.json);
in
buildNpmPackage {
  pname = "rea-agents";
  version = manifest.version;
  nodejs = nodejs_24;

  # Do not import local node_modules, dist, skills, caches, or provider artifacts.
  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../.agents/skills/reverse-engineer-anything
      ../.npmrc
      ../.nvmrc
      ../package.json
      ../package-lock.json
      ../tsconfig.json
      ../tsconfig.build.json
      ../src
      ../scripts
      ../bridge
      ../third_party
      ../licenses
      ../install.sh
      ../README.md
      ../DISCLAIMER.md
      ../THIRD_PARTY_NOTICES.md
      ../LICENSE
    ];
  };

  npmDepsHash = "sha256-5BKi9Jqttxo1/UzhZJi1ec5nFxMpB/anSDRbsr/IiTc=";
  makeCacheWritable = true;
  # Applies to npm rebuild and prune too: Frida's install hook downloads/builds.
  npmFlags = [ "--ignore-scripts" "--no-audit" "--no-fund" ];
  npmBuildScript = "compile";

  nativeBuildInputs = [ autoPatchelfHook makeWrapper jq ];
  buildInputs = [ stdenv.cc.cc.lib ];

  preBuild = ''
    test "$(node --version)" = "v$(tr -d '\n' < .nvmrc)"
    test "npm@$(npm --version)" = "${manifest.packageManager}"
    node scripts/check-dependency-install.mjs
    # Leave Frida explicitly unavailable rather than ship an unbuilt addon.
    rm -rf node_modules/frida
    # npm's forced offline install includes unused musl variants on glibc.
    rm -rf node_modules/*-linux-x64-musl node_modules/@*/*-linux-x64-musl
    # rolldown and the native TypeScript compiler are needed before fixupPhase.
    autoPatchelf node_modules
  '';

  postBuild = ''
    npm run artifacts:skills --ignore-scripts
    node scripts/generate-skill-metadata.mjs --check
  '';

  installPhase = ''
    runHook preInstall

    npm prune --omit=dev --no-save --ignore-scripts --no-audit --no-fund
    rm -rf node_modules/frida
    rm -rf node_modules/*-linux-x64-musl node_modules/@*/*-linux-x64-musl
    npm pack --dry-run --json --ignore-scripts > package-files.json

    # Avoid lib/node_modules: REA's updater interprets that as an npm install.
    packageRoot="$out/lib/rea-agents"
    mkdir -p "$packageRoot" "$out/bin" "$out/libexec"
    while IFS= read -r file; do
      install -Dm644 "$file" "$packageRoot/$file"
    done < <(jq -r '.[0].files[].path' package-files.json)
    cp -r node_modules "$packageRoot/node_modules"

    makeWrapper ${nodejs_24}/bin/node "$out/libexec/rea-node" \
      --prefix PATH : ${lib.makeBinPath [ nodejs_24 procps ]}
    # Setup may register this script directly, so its interpreter owns PATH.
    substituteInPlace "$packageRoot/scripts/rea.mjs" \
      --replace-fail '#!/usr/bin/env node' "#!$out/libexec/rea-node"
    chmod +x "$packageRoot/scripts/rea.mjs"
    ln -s "$packageRoot/scripts/rea.mjs" "$out/bin/rea"
    ln -s "$packageRoot/scripts/rea.mjs" "$out/bin/rea-agents"

    runHook postInstall
  '';

  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    ${nodejs_24}/bin/node ${./smoke-test.mjs} "$out"
    runHook postInstallCheck
  '';

  meta = {
    description = manifest.description;
    homepage = "https://github.com/morluto/rea";
    license = lib.licenses.mit;
    mainProgram = "rea";
    platforms = [ "x86_64-linux" ];
  };
}
