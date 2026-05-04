import type Artplayer from 'artplayer';

/**
 * Apply DecoDock glassmorphism theme to an ArtPlayer instance.
 * Returns a cleanup function that must be called before player.destroy().
 */
export function applyDecoDockTheme(art: Artplayer): () => void {
  const player = art.template.$player;
  let observer: MutationObserver | null = null;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let originalPlaceholder = '';

  // Mark the bottom dock
  const bottom = art.template.$bottom;
  bottom.classList.add('deco-dock-active');

  // Patch danmaku input (may mount async)
  const patchDanmakuInput = () => {
    const input = player.querySelector<HTMLInputElement>(
      '.art-danmuku-send-input',
    );
    if (!input) return false;
    originalPlaceholder = input.placeholder;
    input.placeholder = '友善发言，享受观影';
    input.classList.add('deco-danmaku-input');
    return true;
  };

  if (!patchDanmakuInput()) {
    // Not yet in DOM — observe until it appears
    observer = new MutationObserver(() => {
      if (patchDanmakuInput() && observer) {
        observer.disconnect();
        observer = null;
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
      }
    });
    observer.observe(player, { childList: true, subtree: true });

    // Safety timeout: disconnect after 5s to prevent leaks on pages without danmaku
    timeoutId = setTimeout(() => {
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      timeoutId = null;
    }, 5000);
  }

  // Cleanup function
  return () => {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    bottom.classList.remove('deco-dock-active');
    const input = player.querySelector<HTMLInputElement>(
      '.art-danmuku-send-input',
    );
    if (input) {
      input.classList.remove('deco-danmaku-input');
      if (originalPlaceholder) {
        input.placeholder = originalPlaceholder;
      }
    }
  };
}
