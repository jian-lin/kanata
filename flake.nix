{
  description = "A Gnome extension for kanata";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { nixpkgs, ... }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
    in
    {
      devShells.${system}.default = pkgs.mkShell {
        packages = with pkgs; [
          glib
          gjs
          nodePackages.eslint
          nodePackages.prettier
          nixpkgs-fmt
          nil
        ];
      };
    };
}
