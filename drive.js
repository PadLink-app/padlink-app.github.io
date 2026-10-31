// PadLink and Google Drive: the logo, and the address of Google's own file picker on PadLink's website, which sends
// the picked file back to PadLink (see Server/GoogleDrive.cs). Shared by the pad (Add to the board → Google Drive)
// and the whiteboard on the PC (its Drive button). Exposes window.PadDrive.
(() => {
  'use strict';

  // The Google Drive logo.
  const LOGO = '<svg class="drv-logo" viewBox="0 0 87.3 78" aria-hidden="true">'
    + '<path d="m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8h-27.5c0 1.55.4 3.1 1.2 4.5z" fill="#0066da"/>'
    + '<path d="m43.65 25-13.75-23.8c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44a9.06 9.06 0 0 0 -1.2 4.5h27.5z" fill="#00ac47"/>'
    + '<path d="m73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5h-27.502l5.852 11.5z" fill="#ea4335"/>'
    + '<path d="m43.65 25 13.75-23.8c-1.35-.8-2.9-1.2-4.5-1.2h-18.5c-1.6 0-3.15.45-4.5 1.2z" fill="#00832d"/>'
    + '<path d="m59.8 53h-32.3l-13.75 23.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z" fill="#2684fc"/>'
    + '<path d="m73.4 26.5-12.7-22c-.8-1.4-1.95-2.5-3.3-3.3l-13.75 23.8 16.15 28h27.45c0-1.55-.4-3.1-1.2-4.5z" fill="#ffba00"/>'
    + '</svg>';

  const PadDrive = {
    LOGO,
    PICKER: 'https://larogoth.github.io/PadLink-releases/picker/',

    /** A one-time code for one picker (24 letters, digits, - and _). */
    newCode() {
      const bytes = crypto.getRandomValues(new Uint8Array(18));
      return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_');
    },

    /** The picker's address: it comes back to this PadLink's /drive/return with the code. */
    pickerFor(origin, code) {
      return PadDrive.PICKER + '?r=' + encodeURIComponent(origin.replace(/\/$/, '') + '/drive/return') + '&c=' + encodeURIComponent(code);
    },
  };
  window.PadDrive = PadDrive;
})();
