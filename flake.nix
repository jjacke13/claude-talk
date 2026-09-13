{
  description = "claude-talk — local voice in/out for Claude Code (whisper.cpp + piper)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";

  outputs = { nixpkgs, ... }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
      # Wake-word runtime: everything binary comes from nixpkgs; only the pure-Python
      # `openwakeword` package is pip-installed (--no-deps) into $TALK_STATE_DIR/wake/venv
      # by bin/wake-check.py, because nixpkgs has no python3Packages.openwakeword.
      wakePython = pkgs.python3.withPackages (ps: with ps; [
        onnxruntime numpy scipy tqdm requests sounddevice
      ]);
    in {
      # `nix develop` → everything the scripts shell out to. PipeWire's pw-record/pw-play
      # come from the host system (they need the running daemon anyway).
      devShells.${system}.default = pkgs.mkShell {
        packages = with pkgs; [ bun whisper-cpp piper-tts ffmpeg wakePython ];
      };
    };
}
