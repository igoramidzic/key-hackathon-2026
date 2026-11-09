import { useEffect } from 'react';

/**
 * Mirrors a layout's theme class onto <body> so content portaled out of the layout root
 * (dropdowns, tooltips, popovers) picks up the same tokens and font.
 */
export function useBodyTheme(className: string) {
  useEffect(() => {
    document.body.classList.add(className);
    return () => document.body.classList.remove(className);
  }, [className]);
}

/** Points the tab's favicon at a file in public/ (base-aware) while the shell is mounted. */
export function useFavicon(file: string) {
  useEffect(() => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) return;
    const previous = link.href;
    link.href = `${import.meta.env.BASE_URL}${file}`;
    return () => {
      link.href = previous;
    };
  }, [file]);
}
