{
  description = "oai-image: CLI, SDK and MCP server for OpenAI image generation through a ChatGPT subscription";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = forAllSystems (pkgs: rec {
        oai-image = pkgs.callPackage ./nix/package.nix { };
        default = oai-image;
      });

      overlays.default = final: _prev: {
        oai-image = final.callPackage ./nix/package.nix { };
      };

      apps = forAllSystems (pkgs: {
        default = {
          type = "app";
          program = "${self.packages.${pkgs.stdenv.hostPlatform.system}.oai-image}/bin/oai-image";
        };
        mcp = {
          type = "app";
          program = "${self.packages.${pkgs.stdenv.hostPlatform.system}.oai-image}/bin/oai-image-mcp";
        };
      });

      homeManagerModules.default = import ./nix/home-manager.nix self;

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = [
            pkgs.nodejs_24
            pkgs.bun
          ];
        };
      });

      formatter = forAllSystems (pkgs: pkgs.nixfmt-rfc-style);
    };
}
