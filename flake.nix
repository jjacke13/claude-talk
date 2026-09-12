{
  description = "claude-talk — local voice in/out for Claude Code (whisper.cpp + piper)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";

  outputs = { nixpkgs, ... }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
    in {
      # `nix develop` → everything the scripts shell out to. PipeWire's pw-record/pw-play
      # come from the host system (they need the running daemon anyway).
      devShells.${system}.default = pkgs.mkShell {
        packages = with pkgs; [ bun whisper-cpp piper-tts ffmpeg ];
      };
    };
}
