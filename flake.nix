{
  description = "claude-talk — local voice in/out for Claude Code (whisper.cpp + piper)";

  # Must track the HOST release: the wake mic loads the host PipeWire ALSA plugin, which needs
  # the same (or newer) glibc as this shell (25.11 vs a 26.05 host = "Invalid sample rate").
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
  # Kokoro TTS only: nixos-25.11 has no sherpa-onnx. Locked to the rev the host already runs.
  inputs.nixpkgs-unstable.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { nixpkgs, nixpkgs-unstable, ... }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
      # Wake-word runtime: everything binary comes from nixpkgs; only the pure-Python
      # `openwakeword` package is pip-installed (--no-deps) into $TALK_STATE_DIR/wake/venv
      # by bin/wake-check.py, because nixpkgs has no python3Packages.openwakeword.
      wakePython = pkgs.python3.withPackages (ps: with ps; [
        onnxruntime numpy scipy tqdm requests sounddevice
        scikit-learn onnx   # bin/wake-train only: fits the classifier, writes the .onnx
      ]);
      # bin/kokoro-server: warm Kokoro v1.0 through sherpa-onnx's python bindings (no torch).
      kokoroPython = nixpkgs-unstable.legacyPackages.${system}.python3.withPackages (ps: [ ps.sherpa-onnx ps.numpy ]);
    in {
      # `nix develop` → everything the scripts shell out to. PipeWire's pw-record/pw-play
      # come from the host system (they need the running daemon anyway).
      devShells.${system} = {
        default = pkgs.mkShell {
          packages = with pkgs; [ bun whisper-cpp piper-tts ffmpeg wakePython ];
        };
        kokoro = pkgs.mkShell { packages = [ kokoroPython ]; };
      };
    };
}
