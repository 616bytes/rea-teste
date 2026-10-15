{
  description = "REA CLI and MCP server for x86_64 NixOS";

  # This revision supplies the repository's Node 24.18.0 / npm 11.16.0 toolchain.
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/e11136d15d537efb924780f4bacbabd3340aac28";

  outputs = { nixpkgs, ... }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; };
      rea = pkgs.callPackage ./nix/package.nix { };
    in
    {
      packages.${system} = {
        default = rea;
        inherit rea;
      };

      apps.${system} = {
        default = {
          type = "app";
          program = "${rea}/bin/rea";
          meta.description = rea.meta.description;
        };
        rea = {
          type = "app";
          program = "${rea}/bin/rea";
          meta.description = rea.meta.description;
        };
      };

      checks.${system}.rea = rea;

      devShells.${system}.default = pkgs.mkShell {
        packages = with pkgs; [
          nodejs_24
          git
          python3
          procps
          pkg-config
          patchelf
        ];
      };
    };
}
