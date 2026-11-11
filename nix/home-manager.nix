self:
{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.programs.oai-image;
in
{
  options.programs.oai-image = {
    enable = lib.mkEnableOption "oai-image, the ChatGPT image generation CLI and MCP server";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      defaultText = lib.literalExpression "oai-image.packages.\${system}.default";
      description = "The oai-image package to install. Provides `oai-image` and `oai-image-mcp`.";
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = [ cfg.package ];
  };
}
