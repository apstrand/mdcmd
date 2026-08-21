# mdcmd-bin (AUR)

`PKGBUILD` for the `mdcmd-bin` AUR package: installs the `mdcmd` desktop app
(the Tauri GUI markdown editor) by downloading the Linux `.deb` already
published on the GitHub release and unpacking it, rather than building from
source.

It wraps the real binary (`/usr/lib/mdcmd/mdcmd`) with `/usr/bin/mdcmd`, which
sets `WEBKIT_DISABLE_DMABUF_RENDERER=1` before exec'ing it. Without that,
WebKitGTK's DMA-BUF renderer crashes on wlroots compositors (Hyprland, Sway —
i.e. Omarchy) with `Error 71 (Protocol error) dispatching to Wayland display`.
Confirmed by testing on Omarchy; GNOME/KDE Wayland sessions are unaffected
either way.

## Releasing a new version

This package tracks the `mdcmd` (not `mdc` CLI) GitHub releases, tagged `v*`
in the main repo, which publish a `MarkDown.Commander_<version>_amd64.deb`
asset via `.github/workflows/release.yml`.

1. Bump `pkgver` (and reset `pkgrel=1`) to match the new release tag.
2. Update both `sha256sums` entries:
   ```bash
   makepkg -g >> PKGBUILD   # then dedupe/replace the two sums by hand
   ```
   or download the `.deb` and the tagged `LICENSE` manually and `sha256sum`
   them.
3. Rebuild and regenerate `.SRCINFO`:
   ```bash
   makepkg -f
   makepkg --printsrcinfo > .SRCINFO
   ```
4. Test-install locally: `sudo pacman -U mdcmd-bin-*.pkg.tar.zst`, then launch
   `mdcmd` and confirm the window opens.

## Publishing to the AUR

First time only:
```bash
git clone ssh://aur@aur.archlinux.org/mdcmd-bin.git aur-mdcmd-bin
cp PKGBUILD .SRCINFO aur-mdcmd-bin/
cd aur-mdcmd-bin
git add PKGBUILD .SRCINFO
git commit -m "Initial import"
git push
```

For subsequent updates, copy the two files into the `aur-mdcmd-bin` clone,
commit, and push the same way.
