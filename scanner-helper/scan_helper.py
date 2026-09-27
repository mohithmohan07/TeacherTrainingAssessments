"""Scanner helper for Teacher Training Assessments.

Runs on the Windows laptop the scanner is plugged into, so that the Scan
buttons in the app can feed pages straight from the scanner. A web page cannot
reach a scanner by itself; this helper does it for the page.

- It listens on this computer only (127.0.0.1, port 17645) and only answers
  pages of the Teacher Training Assessments app.
- It drives the scanner through its TWAIN driver (PaperStream IP for the
  Fujitsu SP-1130N), without opening the driver's own window.
- Each scan is also kept as JPEG files under Documents\\Assessment scans, so a
  failed upload never loses the pages.

Start it with "Start scanner helper.cmd", which runs it on the official 32-bit
Python (TWAIN drivers such as PaperStream IP are 32-bit). Close the window to
stop it.
"""

import argparse
import ctypes
import datetime
import http.server
import json
import os
import queue
import re
import struct
import sys
import threading
import time
import traceback
import uuid
from pathlib import Path
from urllib.parse import urlsplit

VERSION = 1
DEFAULT_PORT = 17645

# The app's own address. Pages from anywhere else are refused, so no other
# website can start the scanner. Add an address here if the app ever moves.
APP_ORIGINS = {
    'https://teachertrainingassessments.fly.dev',
}
# The app running on this laptop (npm start) is allowed too, on any port.
LOCAL_ORIGIN = re.compile(r'http://(localhost|127\.0\.0\.1)(:\d{1,5})?')


def origin_allowed(origin):
    return bool(origin) and (origin in APP_ORIGINS or LOCAL_ORIGIN.fullmatch(origin) is not None)


class ScanError(Exception):
    """A problem worth telling the person at the scanner about, in their words."""

    def __init__(self, code, message, status=409):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


def log(message):
    print(f'[{datetime.datetime.now():%H:%M:%S}] {message}', flush=True)


# --------------------------------------------------------------------- TWAIN
#
# Just enough of the TWAIN protocol to scan everything in the feeder with no
# driver window: open the driver manager, open the scanner, set a few
# capabilities, enable it without its UI, then take each page as a native
# (DIB) transfer until none are pending. Structures are packed to 2 bytes, as
# twain.h declares them on Windows.

TW_STR32 = ctypes.c_char * 34


class TW_VERSION(ctypes.Structure):
    _pack_ = 2
    _fields_ = [
        ('MajorNum', ctypes.c_uint16),
        ('MinorNum', ctypes.c_uint16),
        ('Language', ctypes.c_uint16),
        ('Country', ctypes.c_uint16),
        ('Info', TW_STR32),
    ]


class TW_IDENTITY(ctypes.Structure):
    _pack_ = 2
    _fields_ = [
        ('Id', ctypes.c_uint32),
        ('Version', TW_VERSION),
        ('ProtocolMajor', ctypes.c_uint16),
        ('ProtocolMinor', ctypes.c_uint16),
        ('SupportedGroups', ctypes.c_uint32),
        ('Manufacturer', TW_STR32),
        ('ProductFamily', TW_STR32),
        ('ProductName', TW_STR32),
    ]


class TW_USERINTERFACE(ctypes.Structure):
    _pack_ = 2
    _fields_ = [('ShowUI', ctypes.c_uint16), ('ModalUI', ctypes.c_uint16), ('hParent', ctypes.c_void_p)]


class TW_EVENT(ctypes.Structure):
    _pack_ = 2
    _fields_ = [('pEvent', ctypes.c_void_p), ('TWMessage', ctypes.c_uint16)]


class TW_PENDINGXFERS(ctypes.Structure):
    _pack_ = 2
    _fields_ = [('Count', ctypes.c_uint16), ('EOJ', ctypes.c_uint32)]


class TW_STATUS(ctypes.Structure):
    _pack_ = 2
    _fields_ = [('ConditionCode', ctypes.c_uint16), ('Data', ctypes.c_uint16)]


class TW_CAPABILITY(ctypes.Structure):
    _pack_ = 2
    _fields_ = [('Cap', ctypes.c_uint16), ('ConType', ctypes.c_uint16), ('hContainer', ctypes.c_void_p)]


class TW_ONEVALUE(ctypes.Structure):
    _pack_ = 2
    _fields_ = [('ItemType', ctypes.c_uint16), ('Item', ctypes.c_uint32)]


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ('biSize', ctypes.c_uint32),
        ('biWidth', ctypes.c_int32),
        ('biHeight', ctypes.c_int32),
        ('biPlanes', ctypes.c_uint16),
        ('biBitCount', ctypes.c_uint16),
        ('biCompression', ctypes.c_uint32),
        ('biSizeImage', ctypes.c_uint32),
        ('biXPelsPerMeter', ctypes.c_int32),
        ('biYPelsPerMeter', ctypes.c_int32),
        ('biClrUsed', ctypes.c_uint32),
        ('biClrImportant', ctypes.c_uint32),
    ]


class MSG(ctypes.Structure):
    _fields_ = [
        ('hwnd', ctypes.c_void_p),
        ('message', ctypes.c_uint),
        ('wParam', ctypes.c_size_t),
        ('lParam', ctypes.c_ssize_t),
        ('time', ctypes.c_uint32),
        ('x', ctypes.c_long),
        ('y', ctypes.c_long),
    ]


class GUID(ctypes.Structure):
    _fields_ = [('Data1', ctypes.c_uint32), ('Data2', ctypes.c_uint16), ('Data3', ctypes.c_uint16), ('Data4', ctypes.c_ubyte * 8)]

    @classmethod
    def parse(cls, text):
        return cls.from_buffer_copy(uuid.UUID(text).bytes_le)


class GdiplusStartupInput(ctypes.Structure):
    _fields_ = [
        ('GdiplusVersion', ctypes.c_uint32),
        ('DebugEventCallback', ctypes.c_void_p),
        ('SuppressBackgroundThread', ctypes.c_int),
        ('SuppressExternalCodecs', ctypes.c_int),
    ]


class EncoderParameter(ctypes.Structure):
    _fields_ = [('Guid', GUID), ('NumberOfValues', ctypes.c_uint32), ('Type', ctypes.c_uint32), ('Value', ctypes.c_void_p)]


class EncoderParameters(ctypes.Structure):
    _fields_ = [('Count', ctypes.c_uint32), ('Parameter', EncoderParameter * 1)]


DG_CONTROL, DG_IMAGE = 0x0001, 0x0002
DAT_CAPABILITY, DAT_EVENT, DAT_IDENTITY, DAT_PARENT = 0x0001, 0x0002, 0x0003, 0x0004
DAT_PENDINGXFERS, DAT_STATUS, DAT_USERINTERFACE = 0x0005, 0x0008, 0x0009
DAT_IMAGENATIVEXFER = 0x0104
MSG_GET, MSG_GETFIRST, MSG_GETNEXT, MSG_SET, MSG_RESET = 0x0001, 0x0004, 0x0005, 0x0006, 0x0007
MSG_XFERREADY, MSG_CLOSEDSREQ, MSG_CLOSEDSOK = 0x0101, 0x0102, 0x0103
MSG_OPENDSM, MSG_CLOSEDSM, MSG_OPENDS, MSG_CLOSEDS = 0x0301, 0x0302, 0x0401, 0x0402
MSG_DISABLEDS, MSG_ENABLEDS, MSG_PROCESSEVENT, MSG_ENDXFER = 0x0501, 0x0502, 0x0601, 0x0701
TWRC_SUCCESS, TWRC_FAILURE, TWRC_CHECKSTATUS, TWRC_CANCEL = 0, 1, 2, 3
TWRC_DSEVENT, TWRC_XFERDONE = 4, 6
TWON_ONEVALUE = 5
TWTY_INT16, TWTY_INT32, TWTY_UINT16, TWTY_BOOL, TWTY_FIX32 = 1, 2, 4, 6, 7

CAP_XFERCOUNT = 0x0001
ICAP_PIXELTYPE, ICAP_XFERMECH = 0x0101, 0x0103
CAP_FEEDERENABLED, CAP_FEEDERLOADED, CAP_AUTOFEED, CAP_INDICATORS = 0x1002, 0x1003, 0x1007, 0x100b
CAP_DEVICEONLINE = 0x100f
CAP_DUPLEXENABLED = 0x1013
ICAP_XRESOLUTION, ICAP_YRESOLUTION = 0x1118, 0x1119
ICAP_AUTODISCARDBLANKPAGES = 0x1134
ICAP_AUTOMATICDESKEW = 0x1151
ICAP_AUTOSIZE = 0x1156
TWPT_BW, TWPT_GRAY, TWPT_RGB = 0, 1, 2
TWSX_NATIVE = 0
TWBP_DISABLE, TWBP_AUTO = -2, -1
TWAS_AUTO = 1

# TWAIN condition codes that the person at the scanner can do something about.
CONDITIONS = {
    3: ('offline', 'The scanner driver could not be opened. Check the scanner is plugged in and switched on.'),
    4: ('busy', 'The scanner is in use by another program, such as PaperStream Capture. Close it and try again.'),
    # TWCC_OPERATIONERROR: the driver hit a problem and has already shown its own message.
    5: ('driver-error', 'The scanner driver reported a problem and may have shown a message about it on this laptop. Check the scanner, then try again.'),
    20: ('jam', 'The paper jammed. Clear the scanner, put the pages back in the feeder and try again.'),
    21: ('double-feed', 'Two pages went through together. Put the pages back in the feeder and try again.'),
    23: ('offline', 'The scanner is not responding. Check it is plugged in and switched on, then try again.'),
    24: ('cover-open', 'The scanner is open. Close it and try again.'),
    29: ('no-paper', 'There is no paper in the feeder. Put the pages in and press Scan again.'),
}

JPEG_ENCODER = '{557CF401-1A04-11D3-9A73-0000F81EF32E}'
ENCODER_QUALITY = '{1D5BE4B5-FA4A-452D-9CDD-5DB35105E7EB}'
PIXEL_TYPES = {'color': TWPT_RGB, 'gray': TWPT_GRAY, 'bw': TWPT_BW}


class _Job:
    def __init__(self, fn):
        self.fn = fn
        self.done = threading.Event()
        self.result = None
        self.error = None


class TwainScanner:
    """Scans through TWAIN on a thread of its own.

    TWAIN talks to its caller through window messages, so everything happens
    on one thread that owns a hidden window and pumps its messages while a
    scan is running. Other threads hand it work and wait for the answer.
    """

    def __init__(self, dpi=200, color='color'):
        self.dpi = dpi
        self.pixel_type = PIXEL_TYPES[color]
        self._jobs = queue.Queue()
        self._setup_error = None
        threading.Thread(target=self._run, name='twain', daemon=True).start()
        self._call(lambda: None)  # waits for setup, and raises what went wrong there

    # ---- plumbing

    def _run(self):
        try:
            self._setup()
        except BaseException as error:  # reported to every caller
            self._setup_error = error
        while True:
            job = self._jobs.get()
            try:
                if self._setup_error:
                    raise self._setup_error
                job.result = job.fn()
            except BaseException as error:
                job.error = error
            finally:
                job.done.set()

    def _call(self, fn):
        job = _Job(fn)
        self._jobs.put(job)
        job.done.wait()
        if job.error:
            raise job.error
        return job.result

    def _setup(self):
        if struct.calcsize('P') != 4:
            raise ScanError(
                'wrong-python',
                'The helper needs 32-bit Python, because the scanner driver is 32-bit. Start it with "Start scanner helper".',
                500,
            )
        from ctypes import wintypes

        kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
        user32 = ctypes.WinDLL('user32', use_last_error=True)
        ole32 = ctypes.WinDLL('ole32')
        gdiplus = ctypes.WinDLL('gdiplus')

        kernel32.GlobalAlloc.restype = ctypes.c_void_p
        kernel32.GlobalAlloc.argtypes = [wintypes.UINT, ctypes.c_size_t]
        kernel32.GlobalLock.restype = ctypes.c_void_p
        kernel32.GlobalLock.argtypes = [ctypes.c_void_p]
        kernel32.GlobalUnlock.argtypes = [ctypes.c_void_p]
        kernel32.GlobalFree.restype = ctypes.c_void_p
        kernel32.GlobalFree.argtypes = [ctypes.c_void_p]
        user32.CreateWindowExW.restype = ctypes.c_void_p
        user32.CreateWindowExW.argtypes = [
            wintypes.DWORD, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD,
            ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
            ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p,
        ]
        user32.PeekMessageW.argtypes = [ctypes.POINTER(MSG), ctypes.c_void_p, wintypes.UINT, wintypes.UINT, wintypes.UINT]
        user32.TranslateMessage.argtypes = [ctypes.POINTER(MSG)]
        user32.DispatchMessageW.argtypes = [ctypes.POINTER(MSG)]
        gdiplus.GdiplusStartup.argtypes = [ctypes.POINTER(ctypes.c_size_t), ctypes.POINTER(GdiplusStartupInput), ctypes.c_void_p]
        gdiplus.GdipCreateBitmapFromGdiDib.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)]
        gdiplus.GdipSaveImageToFile.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR, ctypes.POINTER(GUID), ctypes.POINTER(EncoderParameters)]
        gdiplus.GdipDisposeImage.argtypes = [ctypes.c_void_p]

        self.kernel32, self.user32, self.gdiplus = kernel32, user32, gdiplus

        ole32.CoInitializeEx(None, 2)  # single-threaded apartment, as drivers expect

        token = ctypes.c_size_t()
        startup = GdiplusStartupInput(1, None, 0, 0)
        if gdiplus.GdiplusStartup(ctypes.byref(token), ctypes.byref(startup), None) != 0:
            raise ScanError('setup', 'Windows could not start its image library (GDI+).', 500)

        # The driver manager: TWAIN 2 if the scanner driver installed it, else Windows' own.
        dsm = None
        for candidate in ('TWAINDSM.dll', os.path.join(os.environ.get('WINDIR', r'C:\Windows'), 'twain_32.dll')):
            try:
                dsm = ctypes.WinDLL(candidate)
                break
            except OSError:
                continue
        if dsm is None:
            raise ScanError('no-twain', 'No TWAIN driver is installed. Install the scanner driver (PaperStream IP) first.', 500)
        self.entry = dsm.DSM_Entry
        self.entry.restype = ctypes.c_uint16
        self.entry.argtypes = [
            ctypes.POINTER(TW_IDENTITY), ctypes.POINTER(TW_IDENTITY),
            ctypes.c_uint32, ctypes.c_uint16, ctypes.c_uint16, ctypes.c_void_p,
        ]

        # A hidden window on this thread, for the driver to post its messages to.
        self.hwnd = user32.CreateWindowExW(0, 'STATIC', 'TTA scanner helper', 0, 0, 0, 0, 0, None, None, None, None)
        if not self.hwnd:
            raise ScanError('setup', 'The helper could not create its message window.', 500)

        self.app = TW_IDENTITY()
        self.app.Version.MajorNum = 1
        self.app.Version.Language = 13  # TWLG_ENGLISH_USA
        self.app.Version.Country = 1  # TWCY_USA
        self.app.Version.Info = b'1.0'
        self.app.ProtocolMajor = 1
        self.app.ProtocolMinor = 9
        self.app.SupportedGroups = DG_CONTROL | DG_IMAGE
        self.app.Manufacturer = b'Teacher Training Assessments'
        self.app.ProductFamily = b'Scanner helper'
        self.app.ProductName = b'TTA scanner helper'

    # ---- TWAIN calls

    def _dsm(self, dest, dg, dat, msg, data):
        return self.entry(ctypes.byref(self.app), ctypes.byref(dest) if dest is not None else None, dg, dat, msg, data)

    def _condition(self, source=None):
        status = TW_STATUS()
        self._dsm(source, DG_CONTROL, DAT_STATUS, MSG_GET, ctypes.byref(status))
        return status.ConditionCode

    def _fail(self, what, source=None):
        code = self._condition(source)
        known = CONDITIONS.get(code)
        if known:
            return ScanError(known[0], known[1], 503 if known[0] == 'offline' else 409)
        return ScanError('twain', f'The scanner driver refused to {what} (TWAIN condition {code}).', 500)

    def _open_manager(self):
        parent = ctypes.c_void_p(self.hwnd)
        if self._dsm(None, DG_CONTROL, DAT_PARENT, MSG_OPENDSM, ctypes.byref(parent)) != TWRC_SUCCESS:
            raise self._fail('start')

    def _close_manager(self):
        parent = ctypes.c_void_p(self.hwnd)
        self._dsm(None, DG_CONTROL, DAT_PARENT, MSG_CLOSEDSM, ctypes.byref(parent))

    def _sources(self):
        found = []
        source = TW_IDENTITY()
        rc = self._dsm(None, DG_CONTROL, DAT_IDENTITY, MSG_GETFIRST, ctypes.byref(source))
        while rc == TWRC_SUCCESS:
            found.append(source)
            source = TW_IDENTITY()
            rc = self._dsm(None, DG_CONTROL, DAT_IDENTITY, MSG_GETNEXT, ctypes.byref(source))
        # Windows lists WIA scanners as TWAIN sources too; real TWAIN drivers first.
        found.sort(key=lambda item: item.ProductName.startswith(b'WIA-'))
        return found

    @staticmethod
    def _name(source):
        return source.ProductName.decode('mbcs' if os.name == 'nt' else 'latin-1', 'replace')

    def _set(self, source, cap, item_type, value):
        size = ctypes.sizeof(TW_ONEVALUE)
        handle = self.kernel32.GlobalAlloc(0x0042, size)  # GHND: movable, zeroed
        if not handle:
            return False
        try:
            one = TW_ONEVALUE.from_address(self.kernel32.GlobalLock(handle))
            one.ItemType = item_type
            one.Item = value & 0xFFFFFFFF
            self.kernel32.GlobalUnlock(handle)
            capability = TW_CAPABILITY(cap, TWON_ONEVALUE, handle)
            rc = self._dsm(source, DG_CONTROL, DAT_CAPABILITY, MSG_SET, ctypes.byref(capability))
            return rc in (TWRC_SUCCESS, TWRC_CHECKSTATUS)
        finally:
            self.kernel32.GlobalFree(handle)

    def _get(self, source, cap):
        capability = TW_CAPABILITY(cap, 0, None)
        if self._dsm(source, DG_CONTROL, DAT_CAPABILITY, MSG_GET, ctypes.byref(capability)) != TWRC_SUCCESS:
            return None
        if not capability.hContainer:
            return None
        try:
            if capability.ConType != TWON_ONEVALUE:
                return None
            value = TW_ONEVALUE.from_address(self.kernel32.GlobalLock(capability.hContainer)).Item
            self.kernel32.GlobalUnlock(capability.hContainer)
            return value
        finally:
            self.kernel32.GlobalFree(capability.hContainer)

    # ---- what the helper asks for

    def list_scanners(self):
        return self._call(self._list)

    def scan(self, scanner_id, both_sides, page_path):
        return self._call(lambda: self._scan(scanner_id, both_sides, page_path))

    def _list(self):
        self._open_manager()
        try:
            names = [self._name(source) for source in self._sources()]
        finally:
            self._close_manager()
        return [{'id': name, 'name': name} for name in names]

    def _scan(self, scanner_id, both_sides, page_path):
        self._open_manager()
        try:
            sources = self._sources()
            if not sources:
                raise ScanError('no-scanner', 'No scanner driver is installed on this laptop.', 503)
            source = next((item for item in sources if self._name(item) == scanner_id), sources[0])
            if self._dsm(None, DG_CONTROL, DAT_IDENTITY, MSG_OPENDS, ctypes.byref(source)) != TWRC_SUCCESS:
                raise self._fail('open the scanner')
            try:
                return self._scan_open(source, both_sides, page_path)
            finally:
                self._dsm(None, DG_CONTROL, DAT_IDENTITY, MSG_CLOSEDS, ctypes.byref(source))
                self._drain()
        finally:
            self._close_manager()

    def _drain(self):
        """Handles messages the driver left behind, so the next scan cannot mistake them for its own."""
        msg = MSG()
        while self.user32.PeekMessageW(ctypes.byref(msg), None, 0, 0, 1):  # PM_REMOVE
            self.user32.TranslateMessage(ctypes.byref(msg))
            self.user32.DispatchMessageW(ctypes.byref(msg))

    def _scan_open(self, source, both_sides, page_path):
        fix32 = self.dpi & 0xFFFF  # whole number of dots per inch, no fraction
        self._set(source, ICAP_XFERMECH, TWTY_UINT16, TWSX_NATIVE)
        self._set(source, ICAP_PIXELTYPE, TWTY_UINT16, self.pixel_type)
        self._set(source, ICAP_XRESOLUTION, TWTY_FIX32, fix32)
        self._set(source, ICAP_YRESOLUTION, TWTY_FIX32, fix32)
        self._set(source, CAP_FEEDERENABLED, TWTY_BOOL, 1)
        self._set(source, CAP_AUTOFEED, TWTY_BOOL, 1)
        self._set(source, CAP_XFERCOUNT, TWTY_INT16, -1)  # every page in the feeder
        self._set(source, CAP_DUPLEXENABLED, TWTY_BOOL, 1 if both_sides else 0)
        # Scanning both sides of one-sided pages would add blank backs; drop them.
        self._set(source, ICAP_AUTODISCARDBLANKPAGES, TWTY_INT32, TWBP_AUTO if both_sides else TWBP_DISABLE)
        self._set(source, ICAP_AUTOSIZE, TWTY_UINT16, TWAS_AUTO)
        self._set(source, ICAP_AUTOMATICDESKEW, TWTY_BOOL, 1)
        self._set(source, CAP_INDICATORS, TWTY_BOOL, 0)

        loaded = self._get(source, CAP_FEEDERLOADED)
        if loaded is not None and loaded & 0xFFFF == 0:
            # A scanner that is switched off or unplugged can look empty too.
            online = self._get(source, CAP_DEVICEONLINE)
            if online is not None and online & 0xFFFF == 0:
                raise ScanError(CONDITIONS[23][0], CONDITIONS[23][1], 503)
            raise ScanError('no-paper', CONDITIONS[29][1])

        ui = TW_USERINTERFACE(0, 0, self.hwnd)
        if self._dsm(source, DG_CONTROL, DAT_USERINTERFACE, MSG_ENABLEDS, ctypes.byref(ui)) == TWRC_FAILURE:
            raise self._fail('start scanning', source)
        try:
            return self._pump(source, page_path)
        except BaseException:
            # Pages the driver has ready but nobody took (the wait ran out, say)
            # must be dropped first: a driver with pages pending refuses to be
            # disabled or closed, and would then refuse every later scan.
            self._dsm(source, DG_CONTROL, DAT_PENDINGXFERS, MSG_RESET, ctypes.byref(TW_PENDINGXFERS()))
            raise
        finally:
            self._dsm(source, DG_CONTROL, DAT_USERINTERFACE, MSG_DISABLEDS, ctypes.byref(ui))

    def _pump(self, source, page_path, wait_seconds=120):
        """Passes window messages to the driver until it has pages ready, then takes them."""
        msg = MSG()
        event = TW_EVENT(ctypes.cast(ctypes.pointer(msg), ctypes.c_void_p), 0)
        deadline = time.monotonic() + wait_seconds
        while True:
            if self.user32.PeekMessageW(ctypes.byref(msg), None, 0, 0, 1):  # PM_REMOVE
                event.TWMessage = 0
                rc = self._dsm(source, DG_CONTROL, DAT_EVENT, MSG_PROCESSEVENT, ctypes.byref(event))
                if rc == TWRC_DSEVENT:
                    if event.TWMessage == MSG_XFERREADY:
                        return self._transfer(source, page_path)
                    if event.TWMessage in (MSG_CLOSEDSREQ, MSG_CLOSEDSOK):
                        raise ScanError('cancelled', 'The scanner stopped before sending any pages.')
                else:
                    self.user32.TranslateMessage(ctypes.byref(msg))
                    self.user32.DispatchMessageW(ctypes.byref(msg))
            elif time.monotonic() > deadline:
                raise ScanError('timeout', 'The scanner did not start. Check it is switched on and the pages are in the feeder.', 504)
            else:
                time.sleep(0.01)

    def _transfer(self, source, page_path):
        paths, warning = [], None
        pending = TW_PENDINGXFERS()
        while True:
            handle = ctypes.c_void_p()
            rc = self._dsm(source, DG_IMAGE, DAT_IMAGENATIVEXFER, MSG_GET, ctypes.byref(handle))
            if rc == TWRC_XFERDONE:
                try:
                    paths.append(self._save(handle.value, page_path(len(paths) + 1)))
                except BaseException:
                    self._dsm(source, DG_CONTROL, DAT_PENDINGXFERS, MSG_ENDXFER, ctypes.byref(pending))
                    self._dsm(source, DG_CONTROL, DAT_PENDINGXFERS, MSG_RESET, ctypes.byref(pending))
                    raise
                finally:
                    self.kernel32.GlobalFree(handle.value)
                self._dsm(source, DG_CONTROL, DAT_PENDINGXFERS, MSG_ENDXFER, ctypes.byref(pending))
                if pending.Count == 0:  # 0xFFFF means "more, number unknown", common with feeders
                    break
                continue

            if rc == TWRC_CANCEL:
                self._dsm(source, DG_CONTROL, DAT_PENDINGXFERS, MSG_ENDXFER, ctypes.byref(pending))
                problem = ScanError('cancelled', 'The scan was cancelled.')
            else:
                problem = self._fail('send the page', source)
            self._dsm(source, DG_CONTROL, DAT_PENDINGXFERS, MSG_RESET, ctypes.byref(pending))
            if not paths:
                raise problem
            warning = f'{problem.message} The {len(paths)} page{"s" if len(paths) != 1 else ""} before that were kept.'
            break
        return {'paths': paths, 'warning': warning}

    def _save(self, handle, path):
        """Writes a native transfer (a DIB in global memory) as a JPEG, or a BMP if that fails.

        `path` has no extension yet. Names can contain dots ("A. Kumar"), so
        the extension is appended rather than set with with_suffix().
        """
        pointer = self.kernel32.GlobalLock(handle)
        try:
            header = BITMAPINFOHEADER.from_address(pointer)
            colors = header.biClrUsed or (1 << header.biBitCount if header.biBitCount <= 8 else 0)
            masks = 12 if header.biCompression == 3 and header.biSize == 40 else 0
            bits = pointer + header.biSize + masks + colors * 4

            bitmap = ctypes.c_void_p()
            if self.gdiplus.GdipCreateBitmapFromGdiDib(pointer, bits, ctypes.byref(bitmap)) == 0:
                try:
                    quality = ctypes.c_uint32(85)
                    params = EncoderParameters(1)
                    params.Parameter[0] = EncoderParameter(GUID.parse(ENCODER_QUALITY), 1, 4, ctypes.cast(ctypes.pointer(quality), ctypes.c_void_p))
                    target = path.parent / f'{path.name}.jpg'
                    encoder = GUID.parse(JPEG_ENCODER)
                    if self.gdiplus.GdipSaveImageToFile(bitmap, str(target), ctypes.byref(encoder), ctypes.byref(params)) == 0:
                        return target
                finally:
                    self.gdiplus.GdipDisposeImage(bitmap)

            # Fallback: the DIB as a .bmp file, which the app accepts too.
            stride = ((header.biWidth * header.biBitCount + 31) // 32) * 4
            image_size = header.biSizeImage or stride * abs(header.biHeight)
            offset = 14 + header.biSize + masks + colors * 4
            data = ctypes.string_at(pointer, offset - 14 + image_size)
            target = path.parent / f'{path.name}.bmp'
            target.write_bytes(b'BM' + struct.pack('<IHHI', 14 + len(data), 0, 0, offset) + data)
            return target
        finally:
            self.kernel32.GlobalUnlock(handle)


# ------------------------------------------------------------ the helper

IMAGE_TYPES = {'.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.bmp': 'image/bmp', '.tif': 'image/tiff'}


def safe_label(text):
    text = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', ' ', str(text or ''))
    text = re.sub(r'\s+', ' ', text).strip(' .')
    return text[:80] or 'Scan'


def documents_folder():
    if os.name == 'nt':
        buffer = ctypes.create_unicode_buffer(260)
        # CSIDL_PERSONAL: the Documents folder, wherever OneDrive has moved it.
        if ctypes.windll.shell32.SHGetFolderPathW(None, 5, None, 0, buffer) == 0 and buffer.value:
            return Path(buffer.value)
    return Path.home() / 'Documents'


class Helper:
    """What the web page can ask for: the scanners, a scan, and its pages."""

    def __init__(self, scanner, folder):
        self.scanner = scanner
        self.folder = Path(folder)
        self.pages = {}
        self.known = []
        self.lock = threading.Lock()

    def status(self):
        if self.lock.locked():  # mid-scan: the scanner thread is busy
            return {'helper': 'tta-scanner-helper', 'version': VERSION, 'scanners': self.known, 'folder': str(self.folder), 'busy': True}
        error = None
        try:
            self.known = self.scanner.list_scanners()
        except ScanError as problem:
            self.known, error = [], problem.message
        except Exception as problem:  # keep answering; the page shows the message
            self.known, error = [], f'The helper could not list scanners: {problem}'
        return {'helper': 'tta-scanner-helper', 'version': VERSION, 'scanners': self.known, 'folder': str(self.folder), 'error': error}

    def scan(self, scanner_id, both_sides, label):
        if not self.lock.acquire(blocking=False):
            raise ScanError('busy', 'A scan is already running. Wait for it to finish.')
        try:
            now = datetime.datetime.now()
            label = safe_label(label)
            folder = self.folder / f'{now:%Y-%m-%d}'
            folder.mkdir(parents=True, exist_ok=True)
            stem = f'{label} - {now:%H-%M-%S}'
            log(f'Scanning for {label}...')
            result = self.scanner.scan(scanner_id, both_sides, lambda number: folder / f'{stem} - p{number}')

            self.pages = {}
            listed = []
            for number, path in enumerate(result['paths'], start=1):
                page_id = uuid.uuid4().hex
                kind = IMAGE_TYPES.get(path.suffix.lower(), 'application/octet-stream')
                self.pages[page_id] = (path, kind)
                listed.append({'id': page_id, 'name': f'{label} - p{number}{path.suffix.lower()}', 'type': kind, 'size': path.stat().st_size})
            log(f'{len(listed)} page{"s" if len(listed) != 1 else ""} scanned, kept in {folder}')
            if result.get('warning'):
                log(result['warning'])
            return {'pages': listed, 'folder': str(folder), 'warning': result.get('warning')}
        except ScanError as problem:
            log(problem.message)
            raise
        finally:
            self.lock.release()

    def page(self, page_id):
        return self.pages.get(page_id)


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = 'TTAScannerHelper/1'
    sys_version = ''
    timeout = 15  # an idle connection does not hold a thread for long

    def log_message(self, format, *args):  # noqa: A002 - the base class's name
        pass  # the helper logs scans itself; per-request lines would bury them

    def _host_ok(self):
        host = (self.headers.get('Host') or '').lower()
        port = self.server.server_address[1]
        return host in (f'127.0.0.1:{port}', f'localhost:{port}')

    def _allowed_origin(self):
        origin = self.headers.get('Origin') or ''
        return origin if self._host_ok() and origin_allowed(origin) else None

    def _send(self, status, body=b'', content_type='application/json; charset=utf-8', origin=None, extra=None):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        if origin:
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
        for name, value in (extra or {}).items():
            self.send_header(name, value)
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _json(self, status, payload, origin=None):
        self._send(status, json.dumps(payload).encode('utf-8'), origin=origin)

    def _refuse(self):
        self._json(403, {'error': 'This helper only answers the Teacher Training Assessments app.'})

    def do_OPTIONS(self):  # noqa: N802 - named by BaseHTTPRequestHandler
        origin = self._allowed_origin()
        if not origin:
            return self._refuse()
        self._send(204, origin=origin, content_type='text/plain', extra={
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
            # Chrome asks this before letting a website reach this computer.
            'Access-Control-Allow-Private-Network': 'true',
            'Access-Control-Max-Age': '600',
        })

    def do_GET(self):  # noqa: N802
        path = urlsplit(self.path).path
        if path == '/' and self._host_ok():
            names = ', '.join(item['name'] for item in self.server.helper.known) or 'none found yet'
            text = f'The scanner helper for Teacher Training Assessments is running.\nScanners: {names}\n'
            return self._send(200, text.encode('utf-8'), 'text/plain; charset=utf-8')

        origin = self._allowed_origin()
        if not origin:
            return self._refuse()
        if path == '/status':
            return self._json(200, self.server.helper.status(), origin)

        match = re.fullmatch(r'/pages/([0-9a-f]{32})', path)
        page = match and self.server.helper.page(match.group(1))
        if page:
            return self._send(200, page[0].read_bytes(), page[1], origin=origin)
        return self._json(404, {'error': 'That page is no longer here. Scan again.'}, origin)

    def do_POST(self):  # noqa: N802
        origin = self._allowed_origin()
        if not origin:
            return self._refuse()
        if urlsplit(self.path).path != '/scan':
            return self._json(404, {'error': 'Not found.'}, origin)

        length = int(self.headers.get('Content-Length') or 0)
        if length > 65536:
            return self._json(413, {'error': 'Request too large.'}, origin)
        try:
            options = json.loads(self.rfile.read(length) or b'{}')
        except ValueError:
            options = {}
        if not isinstance(options, dict):
            options = {}

        try:
            result = self.server.helper.scan(
                scanner_id=str(options.get('scanner') or ''),
                both_sides=options.get('bothSides') is not False,
                label=options.get('label'),
            )
        except ScanError as problem:
            return self._json(problem.status, {'error': problem.message, 'code': problem.code}, origin)
        except Exception as problem:
            traceback.print_exc()
            return self._json(500, {'error': f'The scan failed: {problem}', 'code': 'error'}, origin)
        return self._json(200, result, origin)


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True
    # A second helper must fail to start rather than share the port. On Windows
    # that is what a plain bind does, and SO_REUSEADDR would let both listen.
    # Elsewhere SO_REUSEADDR only skips the wait after a restart.
    allow_reuse_address = os.name != 'nt'


def serve(helper, port=DEFAULT_PORT):
    server = Server(('127.0.0.1', port), Handler)
    server.helper = helper
    return server


def main(argv=None):
    parser = argparse.ArgumentParser(description='Scanner helper for Teacher Training Assessments.')
    parser.add_argument('--port', type=int, default=DEFAULT_PORT)
    parser.add_argument('--dpi', type=int, default=200, help='scan resolution (default 200)')
    parser.add_argument('--color', choices=sorted(PIXEL_TYPES), default='color', help='color, gray or bw (default color)')
    parser.add_argument('--folder', help='where scans are kept (default Documents\\Assessment scans)')
    args = parser.parse_args(argv)

    print('Scanner helper for Teacher Training Assessments', flush=True)
    folder = Path(args.folder) if args.folder else documents_folder() / 'Assessment scans'
    try:
        scanner = TwainScanner(dpi=args.dpi, color=args.color)
        helper = Helper(scanner, folder)
        server = serve(helper, args.port)
    except ScanError as problem:
        print(f'\n{problem.message}', flush=True)
        return 1
    except OSError:
        print(f'\nThe scanner helper is already running (or another program is using port {args.port}).', flush=True)
        return 1

    status = helper.status()
    names = ', '.join(item['name'] for item in status['scanners'])
    print(f'  Scanner: {names or "none found. Check the scanner driver is installed."}')
    print(f'  Scans are also kept in: {folder}')
    print(f'  Listening on http://127.0.0.1:{args.port} (this computer only)')
    print('\nLeave this window open while you scan. Close it to stop the helper.\n', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == '__main__':
    sys.exit(main())
