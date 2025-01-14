/* eslint-disable */
/* Helper functions for debugging */

const { inflateRaw } = require("zlib");
const { default: WindowManager } = require("../state/WindowManager");
const { GTKBridgeEmitter } = require("./state");


const rootDiv = document.createElement("div");
document.body.appendChild(rootDiv);
rootDiv.id = "gtkRoot";

var logDiv = null;
function log(str) {
	if (!logDiv) {
		logDiv = document.createElement("div");
		rootDiv.appendChild(logDiv);
		logDiv.style["position"] = "absolute";
		logDiv.style["right"] = "0px";
	}
	logDiv.appendChild(document.createTextNode(str));
	logDiv.appendChild(document.createElement("br"));
}

function getStackTrace() {
	var callstack = [];
	var isCallstackPopulated = false;
	try {
		i.dont.exist += 0;
	} catch (e) {
		if (e.stack) {
			// Firefox
			var lines = e.stack.split("\n");
			for (var i = 0, len = lines.length; i < len; i++) {
				if (lines[i].match(/^\s*[A-Za-z0-9\-_\$]+\(/)) {
					callstack.push(lines[i]);
				}
			}
			// Remove call to getStackTrace()
			callstack.shift();
			isCallstackPopulated = true;
		} else if (window.opera && e.message) {
			// Opera
			var lines = e.message.split("\n");
			for (var i = 0, len = lines.length; i < len; i++) {
				if (lines[i].match(/^\s*[A-Za-z0-9\-_\$]+\(/)) {
					var entry = lines[i];
					// Append next line also since it has the file info
					if (lines[i + 1]) {
						entry += " at " + lines[i + 1];
						i++;
					}
					callstack.push(entry);
				}
			}
			// Remove call to getStackTrace()
			callstack.shift();
			isCallstackPopulated = true;
		}
	}
	if (!isCallstackPopulated) {
		//IE and Safari
		var currentFunction = arguments.callee.caller;
		while (currentFunction) {
			var fn = currentFunction.toString();
			var fname =
				fn.substring(fn.indexOf("function") + 8, fn.indexOf("(")) ||
				"anonymous";
			callstack.push(fname);
			currentFunction = currentFunction.caller;
		}
	}
	return callstack;
}

function logStackTrace(len) {
	var callstack = getStackTrace();
	var end = callstack.length;
	if (len > 0) end = Math.min(len + 1, end);
	for (var i = 1; i < end; i++) log(callstack[i]);
}

function resizeCanvas(canvas, w, h) {
	/* Canvas resize clears the data, so we need to save it first */
	var tmpCanvas = canvas.ownerDocument.createElement("canvas");
	tmpCanvas.width = canvas.width;
	tmpCanvas.height = canvas.height;
	var tmpContext = tmpCanvas.getContext("2d");
	tmpContext.globalCompositeOperation = "copy";
	tmpContext.drawImage(canvas, 0, 0, tmpCanvas.width, tmpCanvas.height);

	canvas.width = w;
	canvas.height = h;

	var context = canvas.getContext("2d");

	context.globalCompositeOperation = "copy";
	context.drawImage(tmpCanvas, 0, 0, tmpCanvas.width, tmpCanvas.height);
}

var grab = new Object();
grab.window = null;
grab.ownerEvents = false;
grab.implicit = false;
var keyDownList = [];
var lastSerial = 0;
var lastX = 0;
var lastY = 0;
var lastState;
var lastTimeStamp = 0;
var realWindowWithMouse = 0;
var windowWithMouse = 0;
var surfaces = {};
var stackingOrder = [];
var outstandingCommands = new Array();
export var inputSocket = null;
var debugDecoding = false;
var fakeInput = null;
var showKeyboard = false;
var showKeyboardChanged = false;
var firstTouchDownId = null;

var GDK_CROSSING_NORMAL = 0;
var GDK_CROSSING_GRAB = 1;
var GDK_CROSSING_UNGRAB = 2;

// GdkModifierType
var GDK_SHIFT_MASK = 1 << 0;
var GDK_LOCK_MASK = 1 << 1;
var GDK_CONTROL_MASK = 1 << 2;
var GDK_MOD1_MASK = 1 << 3;
var GDK_MOD2_MASK = 1 << 4;
var GDK_MOD3_MASK = 1 << 5;
var GDK_MOD4_MASK = 1 << 6;
var GDK_MOD5_MASK = 1 << 7;
var GDK_BUTTON1_MASK = 1 << 8;
var GDK_BUTTON2_MASK = 1 << 9;
var GDK_BUTTON3_MASK = 1 << 10;
var GDK_BUTTON4_MASK = 1 << 11;
var GDK_BUTTON5_MASK = 1 << 12;
var GDK_SUPER_MASK = 1 << 26;
var GDK_HYPER_MASK = 1 << 27;
var GDK_META_MASK = 1 << 28;
var GDK_RELEASE_MASK = 1 << 30;

function getButtonMask(button) {
	if (button == 1) return GDK_BUTTON1_MASK;
	if (button == 2) return GDK_BUTTON2_MASK;
	if (button == 3) return GDK_BUTTON3_MASK;
	if (button == 4) return GDK_BUTTON4_MASK;
	if (button == 5) return GDK_BUTTON5_MASK;
	return 0;
}

function sendConfigureNotify(surface) {
	sendInput("w", [
		surface.id,
		surface.x,
		surface.y,
		surface.width,
		surface.height,
	]);
}

/**
 * register web-desktop-environment window
 * @param {{ toplevelElement: HTMLElement }} surface
 */
function addWindow(surface) {
	let layer = 0;
	const id = WindowManager.addWindow(
		"gnome-window",
		{ type: "icon", icon: "FcLinux" },
		"#ffffff",
		{ minimized: false }
	);
	WindowManager.emitter.on(
		"updateZIndex",
		({ id: currentId, layer: currentLayer }) => {
			if (currentId === id) {
				layer = currentLayer;
			}
		}
	);
	surface.toplevelElement.addEventListener("mousedown", () => {
		WindowManager.setActiveWindow(id);
	});
	WindowManager.reloadWindowsLayers();
	surface.toplevelElement.focus();
	const doBeforeEveryFrame = () => {
		surface.toplevelElement.style.zIndex = String(layer);
		requestAnimationFrame(doBeforeEveryFrame);
	};
	doBeforeEveryFrame();
	const i = setInterval(() => {
		if (!rootDiv.contains(surface.toplevelElement)) {
			WindowManager.closeWindow(id);
			clearInterval(i);
		}
	});
}

var positionIndex = 0;
function cmdCreateSurface(id, x, y, width, height, isTemp) {
	var surface = {
		id: id,
		x: x,
		y: y,
		width: width,
		height: height,
		isTemp: isTemp,
	};
	surface.positioned = isTemp;
	surface.transientParent = 0;
	surface.visible = false;
	surface.imageData = null;

	var canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	canvas.surface = surface;
	surface.canvas = canvas;
	var toplevelElement;

	toplevelElement = canvas;
	rootDiv.appendChild(canvas);

	surface.toplevelElement = toplevelElement;
	if (!isTemp) {
		addWindow(surface);
	}
	toplevelElement.style["position"] = "absolute";
	/* This positioning isn't strictly right for apps in another topwindow,
	 * but that will be fixed up when showing. */
	toplevelElement.style["left"] = surface.x + "px";
	toplevelElement.style["top"] = surface.y + "px";
	toplevelElement.style["display"] = "inline";

	toplevelElement.style["visibility"] = "hidden";

	surfaces[id] = surface;
	stackingOrder.push(surface);

	sendConfigureNotify(surface);
}

function cmdShowSurface(id) {
	var surface = surfaces[id];

	if (surface.visible) return;
	surface.visible = true;

	var xOffset = surface.x;
	var yOffset = surface.y;

	surface.toplevelElement.style["left"] = xOffset + "px";
	surface.toplevelElement.style["top"] = yOffset + "px";
	surface.toplevelElement.style["visibility"] = "visible";

	restackWindows();
}

function cmdHideSurface(id) {
	if (grab.window == id) doUngrab();

	var surface = surfaces[id];

	if (!surface.visible) return;
	surface.visible = false;

	var element = surface.toplevelElement;

	element.style["visibility"] = "hidden";
}

function cmdSetTransientFor(id, parentId) {
	var surface = surfaces[id];

	if (surface.transientParent == parentId) return;

	surface.transientParent = parentId;
	if (parentId != 0 && surfaces[parentId]) {
		moveToHelper(surface, stackingOrder.indexOf(surfaces[parentId]) + 1);
	}

	if (surface.visible) {
		restackWindows();
	}
}

function restackWindows() {
	stackingOrder = stackingOrder.filter((v) => v);
	for (var i = 0; i < stackingOrder.length; i++) {
		var surface = stackingOrder[i];
		surface.toplevelElement.style.zIndex = i;
	}
}

function moveToHelper(surface, position) {
	var i = stackingOrder.indexOf(surface);
	stackingOrder.splice(i, 1);
	if (position != undefined) stackingOrder.splice(position, 0, surface);
	else stackingOrder.push(surface);

	for (var cid in surfaces) {
		var child = surfaces[cid];
		if (child.transientParent == (surface ? surface.id : null))
			moveToHelper(child, stackingOrder.indexOf(surface) + 1);
	}
}

function cmdDeleteSurface(id) {
	if (grab.window == id) doUngrab();

	var surface = surfaces[id];
	var i = stackingOrder.indexOf(surface);
	if (i >= 0) stackingOrder.splice(i, 1);
	var canvas = surface.canvas;
	canvas.parentNode.removeChild(canvas);
	delete surfaces[id];
}

function cmdMoveResizeSurface(id, has_pos, x, y, has_size, w, h) {
	var surface = surfaces[id];
	if (has_pos) {
		surface.positioned = true;
		surface.x = x;
		surface.y = y;
	}
	if (has_size) {
		surface.width = w;
		surface.height = h;
	}

	if (has_size) resizeCanvas(surface.canvas, w, h);

	if (surface.visible) {
		if (has_pos) {
			var xOffset = surface.x;
			var yOffset = surface.y;

			var element = surface.canvas;

			element.style["left"] = xOffset + "px";
			element.style["top"] = yOffset + "px";
		}
	}

	sendConfigureNotify(surface);
}

function cmdRaiseSurface(id) {
	var surface = surfaces[id];

	moveToHelper(surface);
	restackWindows();
}

function cmdLowerSurface(id) {
	var surface = surfaces[id];

	moveToHelper(surface, 0);
	restackWindows();
}

function copyRect(src, srcX, srcY, dest, destX, destY, width, height) {
	// Clip to src
	if (srcX + width > src.width) width = src.width - srcX;
	if (srcY + height > src.height) height = src.height - srcY;

	// Clip to dest
	if (destX + width > dest.width) width = dest.width - destX;
	if (destY + height > dest.height) height = dest.height - destY;

	var srcRect = src.width * 4 * srcY + srcX * 4;
	var destRect = dest.width * 4 * destY + destX * 4;

	for (var i = 0; i < height; i++) {
		var line = src.data.subarray(srcRect, srcRect + width * 4);
		dest.data.set(line, destRect);
		srcRect += src.width * 4;
		destRect += dest.width * 4;
	}
}

function markRun(dest, start, length, r, g, b) {
	for (var i = start; i < start + length * 4; i += 4) {
		dest[i + 0] = (dest[i + 0] / 2) | (0 + r);
		dest[i + 1] = (dest[i + 1] / 2) | (0 + g);
		dest[i + 2] = (dest[i + 2] / 2) | (0 + b);
	}
}

function markRect(src, srcX, srcY, dest, destX, destY, width, height, r, g, b) {
	// Clip to src
	if (srcX + width > src.width) width = src.width - srcX;
	if (srcY + height > src.height) height = src.height - srcY;

	// Clip to dest
	if (destX + width > dest.width) width = dest.width - destX;
	if (destY + height > dest.height) height = dest.height - destY;

	var destRect = dest.width * 4 * destY + destX * 4;

	for (var i = 0; i < height; i++) {
		if (i == 0 || i == height - 1) markRun(dest.data, destRect, width, 0, 0, 0);
		else {
			markRun(dest.data, destRect, 1, 0, 0, 0);
			markRun(dest.data, destRect + 4, width - 2, r, g, b);
			markRun(dest.data, destRect + 4 * width - 4, 1, 0, 0, 0);
		}
		destRect += dest.width * 4;
	}
}

function decodeBuffer(context, oldData, w, h, data, debug) {
	var i, j;
	var imageData = context.createImageData(w, h);

	if (oldData != null) {
		// Copy old frame into new buffer
		copyRect(oldData, 0, 0, imageData, 0, 0, oldData.width, oldData.height);
	}

	var src = 0;
	var dest = 0;

	while (src < data.length) {
		var b = data[src++];
		var g = data[src++];
		var r = data[src++];
		var alpha = data[src++];
		var len, start;

		if (alpha != 0) {
			// Regular data is red
			if (debug) {
				r = (r / 2) | (0 + 128);
				g = (g / 2) | 0;
				b = (r / 2) | 0;
			}

			imageData.data[dest++] = r;
			imageData.data[dest++] = g;
			imageData.data[dest++] = b;
			imageData.data[dest++] = alpha;
		} else {
			var cmd = r & 0xf0;
			switch (cmd) {
				case 0x00: // Transparent pixel
					//log("Got transparent");
					imageData.data[dest++] = 0;
					imageData.data[dest++] = 0;
					imageData.data[dest++] = 0;
					imageData.data[dest++] = 0;
					break;

				case 0x10: // Delta 0 run
					len = ((r & 0xf) << 16) | (g << 8) | b;
					//log("Got delta0, len: " + len);
					dest += len * 4;
					break;

				case 0x20: // Block reference
					var blockid = ((r & 0xf) << 16) | (g << 8) | b;

					var block_stride = ((oldData.width + 32 - 1) / 32) | 0;
					var srcY = ((blockid / block_stride) | 0) * 32;
					var srcX = (blockid % block_stride | 0) * 32;

					b = data[src++];
					g = data[src++];
					r = data[src++];
					alpha = data[src++];

					var destX = (alpha << 8) | r;
					var destY = (g << 8) | b;

					copyRect(oldData, srcX, srcY, imageData, destX, destY, 32, 32);
					if (debug)
						// blocks are green
						markRect(
							oldData,
							srcX,
							srcY,
							imageData,
							destX,
							destY,
							32,
							32,
							0x00,
							128,
							0x00
						);

					//log("Got block, id: " + blockid +  "(" + srcX +"," + srcY + ") at " + destX + "," + destY);

					break;

				case 0x30: // Color run
					len = ((r & 0xf) << 16) | (g << 8) | b;
					//log("Got color run, len: " + len);

					b = data[src++];
					g = data[src++];
					r = data[src++];
					alpha = data[src++];

					start = dest;

					for (i = 0; i < len; i++) {
						imageData.data[dest++] = r;
						imageData.data[dest++] = g;
						imageData.data[dest++] = b;
						imageData.data[dest++] = alpha;
					}

					if (debug)
						// Color runs are blue
						markRun(imageData.data, start, len, 0x00, 0x00, 128);

					break;

				case 0x40: // Delta run
					len = ((r & 0xf) << 16) | (g << 8) | b;
					//log("Got delta run, len: " + len);

					b = data[src++];
					g = data[src++];
					r = data[src++];
					alpha = data[src++];

					start = dest;

					for (i = 0; i < len; i++) {
						imageData.data[dest] = (imageData.data[dest] + r) & 0xff;
						dest++;
						imageData.data[dest] = (imageData.data[dest] + g) & 0xff;
						dest++;
						imageData.data[dest] = (imageData.data[dest] + b) & 0xff;
						dest++;
						imageData.data[dest] = (imageData.data[dest] + alpha) & 0xff;
						dest++;
					}
					if (debug)
						// Delta runs are violet
						markRun(imageData.data, start, len, 0xff, 0x00, 0xff);
					break;

				default:
					console.error("Unknown buffer commend " + cmd);
			}
		}
	}

	return imageData;
}

function cmdPutBuffer(id, w, h, compressed) {
	var surface = surfaces[id];
	var context = surface.canvas.getContext("2d");

	inflateRaw(compressed, (e, data) => {
		var imageData = decodeBuffer(
			context,
			surface.imageData,
			w,
			h,
			data,
			debugDecoding
		);
		context.putImageData(imageData, 0, 0);

		if (debugDecoding)
			imageData = decodeBuffer(context, surface.imageData, w, h, data, false);

		surface.imageData = imageData;
	});
}

function cmdGrabPointer(id, ownerEvents) {
	doGrab(id, ownerEvents, false);
	sendInput("g", []);
}

function cmdUngrabPointer() {
	sendInput("u", []);
	if (grab.window) doUngrab();
}

var active = false;
function handleCommands(cmd) {
	if (!active) {
		start();
		active = true;
	}

	while (cmd.pos < cmd.length) {
		var id, x, y, w, h, q;
		var command = cmd.get_char();
		lastSerial = cmd.get_32();
		switch (command) {
			case "D":
				inputSocket = null;
				GTKBridgeEmitter.call("status", "disconnected");
				rootDiv.innerHTML = "";
				break;

			case "s": // create new surface
				id = cmd.get_16();
				console.log(id);
				x = cmd.get_16s();
				y = cmd.get_16s();
				w = cmd.get_16();
				h = cmd.get_16();
				var isTemp = cmd.get_bool();
				cmdCreateSurface(id, x, y, w, h, isTemp);
				break;

			case "S": // Show a surface
				id = cmd.get_16();
				cmdShowSurface(id);
				break;

			case "H": // Hide a surface
				id = cmd.get_16();
				cmdHideSurface(id);
				break;

			case "p": // Set transient parent
				id = cmd.get_16();
				var parentId = cmd.get_16();
				cmdSetTransientFor(id, parentId);
				break;

			case "d": // Delete surface
				id = cmd.get_16();
				cmdDeleteSurface(id);
				break;

			case "m": // Move a surface
				id = cmd.get_16();
				var ops = cmd.get_flags();
				var has_pos = ops & 1;
				if (has_pos) {
					x = cmd.get_16s();
					y = cmd.get_16s();
				}
				var has_size = ops & 2;
				if (has_size) {
					w = cmd.get_16();
					h = cmd.get_16();
				}
				cmdMoveResizeSurface(id, has_pos, x, y, has_size, w, h);
				break;

			case "r": // Raise a surface
				id = cmd.get_16();
				cmdRaiseSurface(id);
				break;

			case "R": // Lower a surface
				id = cmd.get_16();
				cmdLowerSurface(id);
				break;

			case "b": // Put image buffer
				id = cmd.get_16();
				w = cmd.get_16();
				h = cmd.get_16();
				var data = cmd.get_data();
				cmdPutBuffer(id, w, h, data);
				break;

			case "g": // Grab
				id = cmd.get_16();
				var ownerEvents = cmd.get_bool();

				cmdGrabPointer(id, ownerEvents);
				break;

			case "u": // Ungrab
				cmdUngrabPointer();
				break;

			case "k": // show keyboard
				showKeyboard = cmd.get_16() != 0;
				showKeyboardChanged = true;
				break;

			default:
				console.error(
					"Unknown op " + command
				);
		}
	}
	return true;
}

function handleOutstanding() {
	while (outstandingCommands.length > 0) {
		var cmd = outstandingCommands.shift();
		if (!handleCommands(cmd)) {
			outstandingCommands.unshift(cmd);
			return;
		}
	}
}

function BinCommands(message) {
	this.arraybuffer = message;
	this.u8 = new Uint8Array(message);
	this.length = this.u8.length;
	this.pos = 0;
}

BinCommands.prototype.get_char = function () {
	return String.fromCharCode(this.u8[this.pos++]);
};
BinCommands.prototype.get_bool = function () {
	return this.u8[this.pos++] != 0;
};
BinCommands.prototype.get_flags = function () {
	return this.u8[this.pos++];
};
BinCommands.prototype.get_16 = function () {
	var v = this.u8[this.pos] + (this.u8[this.pos + 1] << 8);
	this.pos = this.pos + 2;
	return v;
};
BinCommands.prototype.get_16s = function () {
	var v = this.get_16();
	if (v > 32767) return v - 65536;
	else return v;
};
BinCommands.prototype.get_32 = function () {
	var v =
		this.u8[this.pos] +
		(this.u8[this.pos + 1] << 8) +
		(this.u8[this.pos + 2] << 16) +
		(this.u8[this.pos + 3] << 24);
	this.pos = this.pos + 4;
	return v;
};
BinCommands.prototype.get_data = function () {
	var size = this.get_32();
	var data = new Uint8Array(this.arraybuffer, this.pos, size);
	this.pos = this.pos + size;
	return data;
};

function handleMessage(message) {
	var cmd = new BinCommands(message);
	outstandingCommands.push(cmd);
	if (outstandingCommands.length == 1) {
		handleOutstanding();
	}
}

function getSurfaceId(ev) {
	var surface = ev.target.surface;
	if (surface != undefined) return surface.id;
	return 0;
}

function sendInput(cmd, args) {
	if (inputSocket == null) return;

	var fullArgs = [cmd.charCodeAt(0), lastSerial, lastTimeStamp].concat(args);
	var buffer = new ArrayBuffer(fullArgs.length * 4);
	var view = new DataView(buffer);
	fullArgs.forEach(function (arg, i) {
		view.setInt32(i * 4, arg, false);
	});

	inputSocket.send(buffer);
}

function getPositionsFromAbsCoord(absX, absY, relativeId) {
	var res = Object();

	res.rootX = absX;
	res.rootY = absY;
	res.winX = absX;
	res.winY = absY;
	if (relativeId != 0) {
		var surface = surfaces[relativeId];
		res.winX = res.winX - surface.x;
		res.winY = res.winY - surface.y;
	}

	return res;
}

function getPositionsFromEvent(ev, relativeId) {
	var absX, absY;
	absX = ev.pageX;
	absY = ev.pageY;
	var res = getPositionsFromAbsCoord(absX, absY, relativeId);

	lastX = res.rootX;
	lastY = res.rootY;

	return res;
}

function getEffectiveEventTarget(id) {
	if (grab.window != null) {
		if (!grab.ownerEvents) return grab.window;
		if (id == 0) return grab.window;
	}
	return id;
}

function updateKeyboardStatus() {
	if (fakeInput != null && showKeyboardChanged) {
		showKeyboardChanged = false;
		if (showKeyboard) fakeInput.focus();
		else fakeInput.blur();
	}
}

function updateForEvent(ev) {
	lastState &= ~(GDK_SHIFT_MASK | GDK_CONTROL_MASK | GDK_MOD1_MASK);
	if (ev.shiftKey) lastState |= GDK_SHIFT_MASK;
	if (ev.ctrlKey) lastState |= GDK_CONTROL_MASK;
	if (ev.altKey) lastState |= GDK_MOD1_MASK;

	lastTimeStamp = ev.timeStamp;
}

function onMouseMove(ev) {
	updateForEvent(ev);
	var id = getSurfaceId(ev);
	id = getEffectiveEventTarget(id);
	var pos = getPositionsFromEvent(ev, id);
	sendInput("m", [
		realWindowWithMouse,
		id,
		pos.rootX,
		pos.rootY,
		pos.winX,
		pos.winY,
		lastState,
	]);
}

function onMouseOver(ev) {
	updateForEvent(ev);

	var id = getSurfaceId(ev);
	realWindowWithMouse = id;
	id = getEffectiveEventTarget(id);
	var pos = getPositionsFromEvent(ev, id);
	windowWithMouse = id;
	if (windowWithMouse != 0) {
		sendInput("e", [
			realWindowWithMouse,
			id,
			pos.rootX,
			pos.rootY,
			pos.winX,
			pos.winY,
			lastState,
			GDK_CROSSING_NORMAL,
		]);
	}
}

function onMouseOut(ev) {
	updateForEvent(ev);
	var id = getSurfaceId(ev);
	var origId = id;
	id = getEffectiveEventTarget(id);
	var pos = getPositionsFromEvent(ev, id);

	if (id != 0) {
		sendInput("l", [
			realWindowWithMouse,
			id,
			pos.rootX,
			pos.rootY,
			pos.winX,
			pos.winY,
			lastState,
			GDK_CROSSING_NORMAL,
		]);
	}
	realWindowWithMouse = 0;
	windowWithMouse = 0;
}

function doGrab(id, ownerEvents, implicit) {
	var pos;

	if (windowWithMouse != id) {
		if (windowWithMouse != 0) {
			pos = getPositionsFromAbsCoord(lastX, lastY, windowWithMouse);
			sendInput("l", [
				realWindowWithMouse,
				windowWithMouse,
				pos.rootX,
				pos.rootY,
				pos.winX,
				pos.winY,
				lastState,
				GDK_CROSSING_GRAB,
			]);
		}
		pos = getPositionsFromAbsCoord(lastX, lastY, id);
		sendInput("e", [
			realWindowWithMouse,
			id,
			pos.rootX,
			pos.rootY,
			pos.winX,
			pos.winY,
			lastState,
			GDK_CROSSING_GRAB,
		]);
		windowWithMouse = id;
	}

	grab.window = id;
	grab.ownerEvents = ownerEvents;
	grab.implicit = implicit;
}

function doUngrab() {
	var pos;
	if (realWindowWithMouse != windowWithMouse) {
		if (windowWithMouse != 0) {
			pos = getPositionsFromAbsCoord(lastX, lastY, windowWithMouse);
			sendInput("l", [
				realWindowWithMouse,
				windowWithMouse,
				pos.rootX,
				pos.rootY,
				pos.winX,
				pos.winY,
				lastState,
				GDK_CROSSING_UNGRAB,
			]);
		}
		if (realWindowWithMouse != 0) {
			pos = getPositionsFromAbsCoord(lastX, lastY, realWindowWithMouse);
			sendInput("e", [
				realWindowWithMouse,
				realWindowWithMouse,
				pos.rootX,
				pos.rootY,
				pos.winX,
				pos.winY,
				lastState,
				GDK_CROSSING_UNGRAB,
			]);
		}
		windowWithMouse = realWindowWithMouse;
	}
	grab.window = null;
}

function onMouseDown(ev) {
	updateForEvent(ev);
	var button = ev.button + 1;
	lastState = lastState | getButtonMask(button);
	var id = getSurfaceId(ev);
	id = getEffectiveEventTarget(id);

	var pos = getPositionsFromEvent(ev, id);
	if (grab.window == null) doGrab(id, false, true);
	sendInput("b", [
		realWindowWithMouse,
		id,
		pos.rootX,
		pos.rootY,
		pos.winX,
		pos.winY,
		lastState,
		button,
	]);
	return false;
}

function onMouseUp(ev) {
	updateForEvent(ev);
	var button = ev.button + 1;
	lastState = lastState & ~getButtonMask(button);
	var evId = getSurfaceId(ev);
	let id = getEffectiveEventTarget(evId);
	var pos = getPositionsFromEvent(ev, id);

	sendInput("B", [
		realWindowWithMouse,
		id,
		pos.rootX,
		pos.rootY,
		pos.winX,
		pos.winY,
		lastState,
		button,
	]);

	if (grab.window != null && grab.implicit) doUngrab();

	return false;
}

/* Some of the keyboard handling code is from noVNC and
 * (c) Joel Martin (github@martintribe.org), used with permission
 *  Original code at:
 * https://github.com/kanaka/noVNC/blob/master/include/input.js
 */

var unicodeTable = {
	0x0104: 0x01a1,
	0x02d8: 0x01a2,
	0x0141: 0x01a3,
	0x013d: 0x01a5,
	0x015a: 0x01a6,
	0x0160: 0x01a9,
	0x015e: 0x01aa,
	0x0164: 0x01ab,
	0x0179: 0x01ac,
	0x017d: 0x01ae,
	0x017b: 0x01af,
	0x0105: 0x01b1,
	0x02db: 0x01b2,
	0x0142: 0x01b3,
	0x013e: 0x01b5,
	0x015b: 0x01b6,
	0x02c7: 0x01b7,
	0x0161: 0x01b9,
	0x015f: 0x01ba,
	0x0165: 0x01bb,
	0x017a: 0x01bc,
	0x02dd: 0x01bd,
	0x017e: 0x01be,
	0x017c: 0x01bf,
	0x0154: 0x01c0,
	0x0102: 0x01c3,
	0x0139: 0x01c5,
	0x0106: 0x01c6,
	0x010c: 0x01c8,
	0x0118: 0x01ca,
	0x011a: 0x01cc,
	0x010e: 0x01cf,
	0x0110: 0x01d0,
	0x0143: 0x01d1,
	0x0147: 0x01d2,
	0x0150: 0x01d5,
	0x0158: 0x01d8,
	0x016e: 0x01d9,
	0x0170: 0x01db,
	0x0162: 0x01de,
	0x0155: 0x01e0,
	0x0103: 0x01e3,
	0x013a: 0x01e5,
	0x0107: 0x01e6,
	0x010d: 0x01e8,
	0x0119: 0x01ea,
	0x011b: 0x01ec,
	0x010f: 0x01ef,
	0x0111: 0x01f0,
	0x0144: 0x01f1,
	0x0148: 0x01f2,
	0x0151: 0x01f5,
	0x0171: 0x01fb,
	0x0159: 0x01f8,
	0x016f: 0x01f9,
	0x0163: 0x01fe,
	0x02d9: 0x01ff,
	0x0126: 0x02a1,
	0x0124: 0x02a6,
	0x0130: 0x02a9,
	0x011e: 0x02ab,
	0x0134: 0x02ac,
	0x0127: 0x02b1,
	0x0125: 0x02b6,
	0x0131: 0x02b9,
	0x011f: 0x02bb,
	0x0135: 0x02bc,
	0x010a: 0x02c5,
	0x0108: 0x02c6,
	0x0120: 0x02d5,
	0x011c: 0x02d8,
	0x016c: 0x02dd,
	0x015c: 0x02de,
	0x010b: 0x02e5,
	0x0109: 0x02e6,
	0x0121: 0x02f5,
	0x011d: 0x02f8,
	0x016d: 0x02fd,
	0x015d: 0x02fe,
	0x0138: 0x03a2,
	0x0156: 0x03a3,
	0x0128: 0x03a5,
	0x013b: 0x03a6,
	0x0112: 0x03aa,
	0x0122: 0x03ab,
	0x0166: 0x03ac,
	0x0157: 0x03b3,
	0x0129: 0x03b5,
	0x013c: 0x03b6,
	0x0113: 0x03ba,
	0x0123: 0x03bb,
	0x0167: 0x03bc,
	0x014a: 0x03bd,
	0x014b: 0x03bf,
	0x0100: 0x03c0,
	0x012e: 0x03c7,
	0x0116: 0x03cc,
	0x012a: 0x03cf,
	0x0145: 0x03d1,
	0x014c: 0x03d2,
	0x0136: 0x03d3,
	0x0172: 0x03d9,
	0x0168: 0x03dd,
	0x016a: 0x03de,
	0x0101: 0x03e0,
	0x012f: 0x03e7,
	0x0117: 0x03ec,
	0x012b: 0x03ef,
	0x0146: 0x03f1,
	0x014d: 0x03f2,
	0x0137: 0x03f3,
	0x0173: 0x03f9,
	0x0169: 0x03fd,
	0x016b: 0x03fe,
	0x1e02: 0x1001e02,
	0x1e03: 0x1001e03,
	0x1e0a: 0x1001e0a,
	0x1e80: 0x1001e80,
	0x1e82: 0x1001e82,
	0x1e0b: 0x1001e0b,
	0x1ef2: 0x1001ef2,
	0x1e1e: 0x1001e1e,
	0x1e1f: 0x1001e1f,
	0x1e40: 0x1001e40,
	0x1e41: 0x1001e41,
	0x1e56: 0x1001e56,
	0x1e81: 0x1001e81,
	0x1e57: 0x1001e57,
	0x1e83: 0x1001e83,
	0x1e60: 0x1001e60,
	0x1ef3: 0x1001ef3,
	0x1e84: 0x1001e84,
	0x1e85: 0x1001e85,
	0x1e61: 0x1001e61,
	0x0174: 0x1000174,
	0x1e6a: 0x1001e6a,
	0x0176: 0x1000176,
	0x0175: 0x1000175,
	0x1e6b: 0x1001e6b,
	0x0177: 0x1000177,
	0x0152: 0x13bc,
	0x0153: 0x13bd,
	0x0178: 0x13be,
	0x203e: 0x047e,
	0x3002: 0x04a1,
	0x300c: 0x04a2,
	0x300d: 0x04a3,
	0x3001: 0x04a4,
	0x30fb: 0x04a5,
	0x30f2: 0x04a6,
	0x30a1: 0x04a7,
	0x30a3: 0x04a8,
	0x30a5: 0x04a9,
	0x30a7: 0x04aa,
	0x30a9: 0x04ab,
	0x30e3: 0x04ac,
	0x30e5: 0x04ad,
	0x30e7: 0x04ae,
	0x30c3: 0x04af,
	0x30fc: 0x04b0,
	0x30a2: 0x04b1,
	0x30a4: 0x04b2,
	0x30a6: 0x04b3,
	0x30a8: 0x04b4,
	0x30aa: 0x04b5,
	0x30ab: 0x04b6,
	0x30ad: 0x04b7,
	0x30af: 0x04b8,
	0x30b1: 0x04b9,
	0x30b3: 0x04ba,
	0x30b5: 0x04bb,
	0x30b7: 0x04bc,
	0x30b9: 0x04bd,
	0x30bb: 0x04be,
	0x30bd: 0x04bf,
	0x30bf: 0x04c0,
	0x30c1: 0x04c1,
	0x30c4: 0x04c2,
	0x30c6: 0x04c3,
	0x30c8: 0x04c4,
	0x30ca: 0x04c5,
	0x30cb: 0x04c6,
	0x30cc: 0x04c7,
	0x30cd: 0x04c8,
	0x30ce: 0x04c9,
	0x30cf: 0x04ca,
	0x30d2: 0x04cb,
	0x30d5: 0x04cc,
	0x30d8: 0x04cd,
	0x30db: 0x04ce,
	0x30de: 0x04cf,
	0x30df: 0x04d0,
	0x30e0: 0x04d1,
	0x30e1: 0x04d2,
	0x30e2: 0x04d3,
	0x30e4: 0x04d4,
	0x30e6: 0x04d5,
	0x30e8: 0x04d6,
	0x30e9: 0x04d7,
	0x30ea: 0x04d8,
	0x30eb: 0x04d9,
	0x30ec: 0x04da,
	0x30ed: 0x04db,
	0x30ef: 0x04dc,
	0x30f3: 0x04dd,
	0x309b: 0x04de,
	0x309c: 0x04df,
	0x06f0: 0x10006f0,
	0x06f1: 0x10006f1,
	0x06f2: 0x10006f2,
	0x06f3: 0x10006f3,
	0x06f4: 0x10006f4,
	0x06f5: 0x10006f5,
	0x06f6: 0x10006f6,
	0x06f7: 0x10006f7,
	0x06f8: 0x10006f8,
	0x06f9: 0x10006f9,
	0x066a: 0x100066a,
	0x0670: 0x1000670,
	0x0679: 0x1000679,
	0x067e: 0x100067e,
	0x0686: 0x1000686,
	0x0688: 0x1000688,
	0x0691: 0x1000691,
	0x060c: 0x05ac,
	0x06d4: 0x10006d4,
	0x0660: 0x1000660,
	0x0661: 0x1000661,
	0x0662: 0x1000662,
	0x0663: 0x1000663,
	0x0664: 0x1000664,
	0x0665: 0x1000665,
	0x0666: 0x1000666,
	0x0667: 0x1000667,
	0x0668: 0x1000668,
	0x0669: 0x1000669,
	0x061b: 0x05bb,
	0x061f: 0x05bf,
	0x0621: 0x05c1,
	0x0622: 0x05c2,
	0x0623: 0x05c3,
	0x0624: 0x05c4,
	0x0625: 0x05c5,
	0x0626: 0x05c6,
	0x0627: 0x05c7,
	0x0628: 0x05c8,
	0x0629: 0x05c9,
	0x062a: 0x05ca,
	0x062b: 0x05cb,
	0x062c: 0x05cc,
	0x062d: 0x05cd,
	0x062e: 0x05ce,
	0x062f: 0x05cf,
	0x0630: 0x05d0,
	0x0631: 0x05d1,
	0x0632: 0x05d2,
	0x0633: 0x05d3,
	0x0634: 0x05d4,
	0x0635: 0x05d5,
	0x0636: 0x05d6,
	0x0637: 0x05d7,
	0x0638: 0x05d8,
	0x0639: 0x05d9,
	0x063a: 0x05da,
	0x0640: 0x05e0,
	0x0641: 0x05e1,
	0x0642: 0x05e2,
	0x0643: 0x05e3,
	0x0644: 0x05e4,
	0x0645: 0x05e5,
	0x0646: 0x05e6,
	0x0647: 0x05e7,
	0x0648: 0x05e8,
	0x0649: 0x05e9,
	0x064a: 0x05ea,
	0x064b: 0x05eb,
	0x064c: 0x05ec,
	0x064d: 0x05ed,
	0x064e: 0x05ee,
	0x064f: 0x05ef,
	0x0650: 0x05f0,
	0x0651: 0x05f1,
	0x0652: 0x05f2,
	0x0653: 0x1000653,
	0x0654: 0x1000654,
	0x0655: 0x1000655,
	0x0698: 0x1000698,
	0x06a4: 0x10006a4,
	0x06a9: 0x10006a9,
	0x06af: 0x10006af,
	0x06ba: 0x10006ba,
	0x06be: 0x10006be,
	0x06cc: 0x10006cc,
	0x06d2: 0x10006d2,
	0x06c1: 0x10006c1,
	0x0492: 0x1000492,
	0x0493: 0x1000493,
	0x0496: 0x1000496,
	0x0497: 0x1000497,
	0x049a: 0x100049a,
	0x049b: 0x100049b,
	0x049c: 0x100049c,
	0x049d: 0x100049d,
	0x04a2: 0x10004a2,
	0x04a3: 0x10004a3,
	0x04ae: 0x10004ae,
	0x04af: 0x10004af,
	0x04b0: 0x10004b0,
	0x04b1: 0x10004b1,
	0x04b2: 0x10004b2,
	0x04b3: 0x10004b3,
	0x04b6: 0x10004b6,
	0x04b7: 0x10004b7,
	0x04b8: 0x10004b8,
	0x04b9: 0x10004b9,
	0x04ba: 0x10004ba,
	0x04bb: 0x10004bb,
	0x04d8: 0x10004d8,
	0x04d9: 0x10004d9,
	0x04e2: 0x10004e2,
	0x04e3: 0x10004e3,
	0x04e8: 0x10004e8,
	0x04e9: 0x10004e9,
	0x04ee: 0x10004ee,
	0x04ef: 0x10004ef,
	0x0452: 0x06a1,
	0x0453: 0x06a2,
	0x0451: 0x06a3,
	0x0454: 0x06a4,
	0x0455: 0x06a5,
	0x0456: 0x06a6,
	0x0457: 0x06a7,
	0x0458: 0x06a8,
	0x0459: 0x06a9,
	0x045a: 0x06aa,
	0x045b: 0x06ab,
	0x045c: 0x06ac,
	0x0491: 0x06ad,
	0x045e: 0x06ae,
	0x045f: 0x06af,
	0x2116: 0x06b0,
	0x0402: 0x06b1,
	0x0403: 0x06b2,
	0x0401: 0x06b3,
	0x0404: 0x06b4,
	0x0405: 0x06b5,
	0x0406: 0x06b6,
	0x0407: 0x06b7,
	0x0408: 0x06b8,
	0x0409: 0x06b9,
	0x040a: 0x06ba,
	0x040b: 0x06bb,
	0x040c: 0x06bc,
	0x0490: 0x06bd,
	0x040e: 0x06be,
	0x040f: 0x06bf,
	0x044e: 0x06c0,
	0x0430: 0x06c1,
	0x0431: 0x06c2,
	0x0446: 0x06c3,
	0x0434: 0x06c4,
	0x0435: 0x06c5,
	0x0444: 0x06c6,
	0x0433: 0x06c7,
	0x0445: 0x06c8,
	0x0438: 0x06c9,
	0x0439: 0x06ca,
	0x043a: 0x06cb,
	0x043b: 0x06cc,
	0x043c: 0x06cd,
	0x043d: 0x06ce,
	0x043e: 0x06cf,
	0x043f: 0x06d0,
	0x044f: 0x06d1,
	0x0440: 0x06d2,
	0x0441: 0x06d3,
	0x0442: 0x06d4,
	0x0443: 0x06d5,
	0x0436: 0x06d6,
	0x0432: 0x06d7,
	0x044c: 0x06d8,
	0x044b: 0x06d9,
	0x0437: 0x06da,
	0x0448: 0x06db,
	0x044d: 0x06dc,
	0x0449: 0x06dd,
	0x0447: 0x06de,
	0x044a: 0x06df,
	0x042e: 0x06e0,
	0x0410: 0x06e1,
	0x0411: 0x06e2,
	0x0426: 0x06e3,
	0x0414: 0x06e4,
	0x0415: 0x06e5,
	0x0424: 0x06e6,
	0x0413: 0x06e7,
	0x0425: 0x06e8,
	0x0418: 0x06e9,
	0x0419: 0x06ea,
	0x041a: 0x06eb,
	0x041b: 0x06ec,
	0x041c: 0x06ed,
	0x041d: 0x06ee,
	0x041e: 0x06ef,
	0x041f: 0x06f0,
	0x042f: 0x06f1,
	0x0420: 0x06f2,
	0x0421: 0x06f3,
	0x0422: 0x06f4,
	0x0423: 0x06f5,
	0x0416: 0x06f6,
	0x0412: 0x06f7,
	0x042c: 0x06f8,
	0x042b: 0x06f9,
	0x0417: 0x06fa,
	0x0428: 0x06fb,
	0x042d: 0x06fc,
	0x0429: 0x06fd,
	0x0427: 0x06fe,
	0x042a: 0x06ff,
	0x0386: 0x07a1,
	0x0388: 0x07a2,
	0x0389: 0x07a3,
	0x038a: 0x07a4,
	0x03aa: 0x07a5,
	0x038c: 0x07a7,
	0x038e: 0x07a8,
	0x03ab: 0x07a9,
	0x038f: 0x07ab,
	0x0385: 0x07ae,
	0x2015: 0x07af,
	0x03ac: 0x07b1,
	0x03ad: 0x07b2,
	0x03ae: 0x07b3,
	0x03af: 0x07b4,
	0x03ca: 0x07b5,
	0x0390: 0x07b6,
	0x03cc: 0x07b7,
	0x03cd: 0x07b8,
	0x03cb: 0x07b9,
	0x03b0: 0x07ba,
	0x03ce: 0x07bb,
	0x0391: 0x07c1,
	0x0392: 0x07c2,
	0x0393: 0x07c3,
	0x0394: 0x07c4,
	0x0395: 0x07c5,
	0x0396: 0x07c6,
	0x0397: 0x07c7,
	0x0398: 0x07c8,
	0x0399: 0x07c9,
	0x039a: 0x07ca,
	0x039b: 0x07cb,
	0x039c: 0x07cc,
	0x039d: 0x07cd,
	0x039e: 0x07ce,
	0x039f: 0x07cf,
	0x03a0: 0x07d0,
	0x03a1: 0x07d1,
	0x03a3: 0x07d2,
	0x03a4: 0x07d4,
	0x03a5: 0x07d5,
	0x03a6: 0x07d6,
	0x03a7: 0x07d7,
	0x03a8: 0x07d8,
	0x03a9: 0x07d9,
	0x03b1: 0x07e1,
	0x03b2: 0x07e2,
	0x03b3: 0x07e3,
	0x03b4: 0x07e4,
	0x03b5: 0x07e5,
	0x03b6: 0x07e6,
	0x03b7: 0x07e7,
	0x03b8: 0x07e8,
	0x03b9: 0x07e9,
	0x03ba: 0x07ea,
	0x03bb: 0x07eb,
	0x03bc: 0x07ec,
	0x03bd: 0x07ed,
	0x03be: 0x07ee,
	0x03bf: 0x07ef,
	0x03c0: 0x07f0,
	0x03c1: 0x07f1,
	0x03c3: 0x07f2,
	0x03c2: 0x07f3,
	0x03c4: 0x07f4,
	0x03c5: 0x07f5,
	0x03c6: 0x07f6,
	0x03c7: 0x07f7,
	0x03c8: 0x07f8,
	0x03c9: 0x07f9,
	0x23b7: 0x08a1,
	0x2320: 0x08a4,
	0x2321: 0x08a5,
	0x23a1: 0x08a7,
	0x23a3: 0x08a8,
	0x23a4: 0x08a9,
	0x23a6: 0x08aa,
	0x239b: 0x08ab,
	0x239d: 0x08ac,
	0x239e: 0x08ad,
	0x23a0: 0x08ae,
	0x23a8: 0x08af,
	0x23ac: 0x08b0,
	0x2264: 0x08bc,
	0x2260: 0x08bd,
	0x2265: 0x08be,
	0x222b: 0x08bf,
	0x2234: 0x08c0,
	0x221d: 0x08c1,
	0x221e: 0x08c2,
	0x2207: 0x08c5,
	0x223c: 0x08c8,
	0x2243: 0x08c9,
	0x21d4: 0x08cd,
	0x21d2: 0x08ce,
	0x2261: 0x08cf,
	0x221a: 0x08d6,
	0x2282: 0x08da,
	0x2283: 0x08db,
	0x2229: 0x08dc,
	0x222a: 0x08dd,
	0x2227: 0x08de,
	0x2228: 0x08df,
	0x2202: 0x08ef,
	0x0192: 0x08f6,
	0x2190: 0x08fb,
	0x2191: 0x08fc,
	0x2192: 0x08fd,
	0x2193: 0x08fe,
	0x25c6: 0x09e0,
	0x2592: 0x09e1,
	0x2409: 0x09e2,
	0x240c: 0x09e3,
	0x240d: 0x09e4,
	0x240a: 0x09e5,
	0x2424: 0x09e8,
	0x240b: 0x09e9,
	0x2518: 0x09ea,
	0x2510: 0x09eb,
	0x250c: 0x09ec,
	0x2514: 0x09ed,
	0x253c: 0x09ee,
	0x23ba: 0x09ef,
	0x23bb: 0x09f0,
	0x2500: 0x09f1,
	0x23bc: 0x09f2,
	0x23bd: 0x09f3,
	0x251c: 0x09f4,
	0x2524: 0x09f5,
	0x2534: 0x09f6,
	0x252c: 0x09f7,
	0x2502: 0x09f8,
	0x2003: 0x0aa1,
	0x2002: 0x0aa2,
	0x2004: 0x0aa3,
	0x2005: 0x0aa4,
	0x2007: 0x0aa5,
	0x2008: 0x0aa6,
	0x2009: 0x0aa7,
	0x200a: 0x0aa8,
	0x2014: 0x0aa9,
	0x2013: 0x0aaa,
	0x2026: 0x0aae,
	0x2025: 0x0aaf,
	0x2153: 0x0ab0,
	0x2154: 0x0ab1,
	0x2155: 0x0ab2,
	0x2156: 0x0ab3,
	0x2157: 0x0ab4,
	0x2158: 0x0ab5,
	0x2159: 0x0ab6,
	0x215a: 0x0ab7,
	0x2105: 0x0ab8,
	0x2012: 0x0abb,
	0x215b: 0x0ac3,
	0x215c: 0x0ac4,
	0x215d: 0x0ac5,
	0x215e: 0x0ac6,
	0x2122: 0x0ac9,
	0x2018: 0x0ad0,
	0x2019: 0x0ad1,
	0x201c: 0x0ad2,
	0x201d: 0x0ad3,
	0x211e: 0x0ad4,
	0x2032: 0x0ad6,
	0x2033: 0x0ad7,
	0x271d: 0x0ad9,
	0x2663: 0x0aec,
	0x2666: 0x0aed,
	0x2665: 0x0aee,
	0x2720: 0x0af0,
	0x2020: 0x0af1,
	0x2021: 0x0af2,
	0x2713: 0x0af3,
	0x2717: 0x0af4,
	0x266f: 0x0af5,
	0x266d: 0x0af6,
	0x2642: 0x0af7,
	0x2640: 0x0af8,
	0x260e: 0x0af9,
	0x2315: 0x0afa,
	0x2117: 0x0afb,
	0x2038: 0x0afc,
	0x201a: 0x0afd,
	0x201e: 0x0afe,
	0x22a4: 0x0bc2,
	0x230a: 0x0bc4,
	0x2218: 0x0bca,
	0x2395: 0x0bcc,
	0x22a5: 0x0bce,
	0x25cb: 0x0bcf,
	0x2308: 0x0bd3,
	0x22a3: 0x0bdc,
	0x22a2: 0x0bfc,
	0x2017: 0x0cdf,
	0x05d0: 0x0ce0,
	0x05d1: 0x0ce1,
	0x05d2: 0x0ce2,
	0x05d3: 0x0ce3,
	0x05d4: 0x0ce4,
	0x05d5: 0x0ce5,
	0x05d6: 0x0ce6,
	0x05d7: 0x0ce7,
	0x05d8: 0x0ce8,
	0x05d9: 0x0ce9,
	0x05da: 0x0cea,
	0x05db: 0x0ceb,
	0x05dc: 0x0cec,
	0x05dd: 0x0ced,
	0x05de: 0x0cee,
	0x05df: 0x0cef,
	0x05e0: 0x0cf0,
	0x05e1: 0x0cf1,
	0x05e2: 0x0cf2,
	0x05e3: 0x0cf3,
	0x05e4: 0x0cf4,
	0x05e5: 0x0cf5,
	0x05e6: 0x0cf6,
	0x05e7: 0x0cf7,
	0x05e8: 0x0cf8,
	0x05e9: 0x0cf9,
	0x05ea: 0x0cfa,
	0x0e01: 0x0da1,
	0x0e02: 0x0da2,
	0x0e03: 0x0da3,
	0x0e04: 0x0da4,
	0x0e05: 0x0da5,
	0x0e06: 0x0da6,
	0x0e07: 0x0da7,
	0x0e08: 0x0da8,
	0x0e09: 0x0da9,
	0x0e0a: 0x0daa,
	0x0e0b: 0x0dab,
	0x0e0c: 0x0dac,
	0x0e0d: 0x0dad,
	0x0e0e: 0x0dae,
	0x0e0f: 0x0daf,
	0x0e10: 0x0db0,
	0x0e11: 0x0db1,
	0x0e12: 0x0db2,
	0x0e13: 0x0db3,
	0x0e14: 0x0db4,
	0x0e15: 0x0db5,
	0x0e16: 0x0db6,
	0x0e17: 0x0db7,
	0x0e18: 0x0db8,
	0x0e19: 0x0db9,
	0x0e1a: 0x0dba,
	0x0e1b: 0x0dbb,
	0x0e1c: 0x0dbc,
	0x0e1d: 0x0dbd,
	0x0e1e: 0x0dbe,
	0x0e1f: 0x0dbf,
	0x0e20: 0x0dc0,
	0x0e21: 0x0dc1,
	0x0e22: 0x0dc2,
	0x0e23: 0x0dc3,
	0x0e24: 0x0dc4,
	0x0e25: 0x0dc5,
	0x0e26: 0x0dc6,
	0x0e27: 0x0dc7,
	0x0e28: 0x0dc8,
	0x0e29: 0x0dc9,
	0x0e2a: 0x0dca,
	0x0e2b: 0x0dcb,
	0x0e2c: 0x0dcc,
	0x0e2d: 0x0dcd,
	0x0e2e: 0x0dce,
	0x0e2f: 0x0dcf,
	0x0e30: 0x0dd0,
	0x0e31: 0x0dd1,
	0x0e32: 0x0dd2,
	0x0e33: 0x0dd3,
	0x0e34: 0x0dd4,
	0x0e35: 0x0dd5,
	0x0e36: 0x0dd6,
	0x0e37: 0x0dd7,
	0x0e38: 0x0dd8,
	0x0e39: 0x0dd9,
	0x0e3a: 0x0dda,
	0x0e3f: 0x0ddf,
	0x0e40: 0x0de0,
	0x0e41: 0x0de1,
	0x0e42: 0x0de2,
	0x0e43: 0x0de3,
	0x0e44: 0x0de4,
	0x0e45: 0x0de5,
	0x0e46: 0x0de6,
	0x0e47: 0x0de7,
	0x0e48: 0x0de8,
	0x0e49: 0x0de9,
	0x0e4a: 0x0dea,
	0x0e4b: 0x0deb,
	0x0e4c: 0x0dec,
	0x0e4d: 0x0ded,
	0x0e50: 0x0df0,
	0x0e51: 0x0df1,
	0x0e52: 0x0df2,
	0x0e53: 0x0df3,
	0x0e54: 0x0df4,
	0x0e55: 0x0df5,
	0x0e56: 0x0df6,
	0x0e57: 0x0df7,
	0x0e58: 0x0df8,
	0x0e59: 0x0df9,
	0x0587: 0x1000587,
	0x0589: 0x1000589,
	0x055d: 0x100055d,
	0x058a: 0x100058a,
	0x055c: 0x100055c,
	0x055b: 0x100055b,
	0x055e: 0x100055e,
	0x0531: 0x1000531,
	0x0561: 0x1000561,
	0x0532: 0x1000532,
	0x0562: 0x1000562,
	0x0533: 0x1000533,
	0x0563: 0x1000563,
	0x0534: 0x1000534,
	0x0564: 0x1000564,
	0x0535: 0x1000535,
	0x0565: 0x1000565,
	0x0536: 0x1000536,
	0x0566: 0x1000566,
	0x0537: 0x1000537,
	0x0567: 0x1000567,
	0x0538: 0x1000538,
	0x0568: 0x1000568,
	0x0539: 0x1000539,
	0x0569: 0x1000569,
	0x053a: 0x100053a,
	0x056a: 0x100056a,
	0x053b: 0x100053b,
	0x056b: 0x100056b,
	0x053c: 0x100053c,
	0x056c: 0x100056c,
	0x053d: 0x100053d,
	0x056d: 0x100056d,
	0x053e: 0x100053e,
	0x056e: 0x100056e,
	0x053f: 0x100053f,
	0x056f: 0x100056f,
	0x0540: 0x1000540,
	0x0570: 0x1000570,
	0x0541: 0x1000541,
	0x0571: 0x1000571,
	0x0542: 0x1000542,
	0x0572: 0x1000572,
	0x0543: 0x1000543,
	0x0573: 0x1000573,
	0x0544: 0x1000544,
	0x0574: 0x1000574,
	0x0545: 0x1000545,
	0x0575: 0x1000575,
	0x0546: 0x1000546,
	0x0576: 0x1000576,
	0x0547: 0x1000547,
	0x0577: 0x1000577,
	0x0548: 0x1000548,
	0x0578: 0x1000578,
	0x0549: 0x1000549,
	0x0579: 0x1000579,
	0x054a: 0x100054a,
	0x057a: 0x100057a,
	0x054b: 0x100054b,
	0x057b: 0x100057b,
	0x054c: 0x100054c,
	0x057c: 0x100057c,
	0x054d: 0x100054d,
	0x057d: 0x100057d,
	0x054e: 0x100054e,
	0x057e: 0x100057e,
	0x054f: 0x100054f,
	0x057f: 0x100057f,
	0x0550: 0x1000550,
	0x0580: 0x1000580,
	0x0551: 0x1000551,
	0x0581: 0x1000581,
	0x0552: 0x1000552,
	0x0582: 0x1000582,
	0x0553: 0x1000553,
	0x0583: 0x1000583,
	0x0554: 0x1000554,
	0x0584: 0x1000584,
	0x0555: 0x1000555,
	0x0585: 0x1000585,
	0x0556: 0x1000556,
	0x0586: 0x1000586,
	0x055a: 0x100055a,
	0x10d0: 0x10010d0,
	0x10d1: 0x10010d1,
	0x10d2: 0x10010d2,
	0x10d3: 0x10010d3,
	0x10d4: 0x10010d4,
	0x10d5: 0x10010d5,
	0x10d6: 0x10010d6,
	0x10d7: 0x10010d7,
	0x10d8: 0x10010d8,
	0x10d9: 0x10010d9,
	0x10da: 0x10010da,
	0x10db: 0x10010db,
	0x10dc: 0x10010dc,
	0x10dd: 0x10010dd,
	0x10de: 0x10010de,
	0x10df: 0x10010df,
	0x10e0: 0x10010e0,
	0x10e1: 0x10010e1,
	0x10e2: 0x10010e2,
	0x10e3: 0x10010e3,
	0x10e4: 0x10010e4,
	0x10e5: 0x10010e5,
	0x10e6: 0x10010e6,
	0x10e7: 0x10010e7,
	0x10e8: 0x10010e8,
	0x10e9: 0x10010e9,
	0x10ea: 0x10010ea,
	0x10eb: 0x10010eb,
	0x10ec: 0x10010ec,
	0x10ed: 0x10010ed,
	0x10ee: 0x10010ee,
	0x10ef: 0x10010ef,
	0x10f0: 0x10010f0,
	0x10f1: 0x10010f1,
	0x10f2: 0x10010f2,
	0x10f3: 0x10010f3,
	0x10f4: 0x10010f4,
	0x10f5: 0x10010f5,
	0x10f6: 0x10010f6,
	0x1e8a: 0x1001e8a,
	0x012c: 0x100012c,
	0x01b5: 0x10001b5,
	0x01e6: 0x10001e6,
	0x01d2: 0x10001d1,
	0x019f: 0x100019f,
	0x1e8b: 0x1001e8b,
	0x012d: 0x100012d,
	0x01b6: 0x10001b6,
	0x01e7: 0x10001e7,
	0x01d2: 0x10001d2,
	0x0275: 0x1000275,
	0x018f: 0x100018f,
	0x0259: 0x1000259,
	0x1e36: 0x1001e36,
	0x1e37: 0x1001e37,
	0x1ea0: 0x1001ea0,
	0x1ea1: 0x1001ea1,
	0x1ea2: 0x1001ea2,
	0x1ea3: 0x1001ea3,
	0x1ea4: 0x1001ea4,
	0x1ea5: 0x1001ea5,
	0x1ea6: 0x1001ea6,
	0x1ea7: 0x1001ea7,
	0x1ea8: 0x1001ea8,
	0x1ea9: 0x1001ea9,
	0x1eaa: 0x1001eaa,
	0x1eab: 0x1001eab,
	0x1eac: 0x1001eac,
	0x1ead: 0x1001ead,
	0x1eae: 0x1001eae,
	0x1eaf: 0x1001eaf,
	0x1eb0: 0x1001eb0,
	0x1eb1: 0x1001eb1,
	0x1eb2: 0x1001eb2,
	0x1eb3: 0x1001eb3,
	0x1eb4: 0x1001eb4,
	0x1eb5: 0x1001eb5,
	0x1eb6: 0x1001eb6,
	0x1eb7: 0x1001eb7,
	0x1eb8: 0x1001eb8,
	0x1eb9: 0x1001eb9,
	0x1eba: 0x1001eba,
	0x1ebb: 0x1001ebb,
	0x1ebc: 0x1001ebc,
	0x1ebd: 0x1001ebd,
	0x1ebe: 0x1001ebe,
	0x1ebf: 0x1001ebf,
	0x1ec0: 0x1001ec0,
	0x1ec1: 0x1001ec1,
	0x1ec2: 0x1001ec2,
	0x1ec3: 0x1001ec3,
	0x1ec4: 0x1001ec4,
	0x1ec5: 0x1001ec5,
	0x1ec6: 0x1001ec6,
	0x1ec7: 0x1001ec7,
	0x1ec8: 0x1001ec8,
	0x1ec9: 0x1001ec9,
	0x1eca: 0x1001eca,
	0x1ecb: 0x1001ecb,
	0x1ecc: 0x1001ecc,
	0x1ecd: 0x1001ecd,
	0x1ece: 0x1001ece,
	0x1ecf: 0x1001ecf,
	0x1ed0: 0x1001ed0,
	0x1ed1: 0x1001ed1,
	0x1ed2: 0x1001ed2,
	0x1ed3: 0x1001ed3,
	0x1ed4: 0x1001ed4,
	0x1ed5: 0x1001ed5,
	0x1ed6: 0x1001ed6,
	0x1ed7: 0x1001ed7,
	0x1ed8: 0x1001ed8,
	0x1ed9: 0x1001ed9,
	0x1eda: 0x1001eda,
	0x1edb: 0x1001edb,
	0x1edc: 0x1001edc,
	0x1edd: 0x1001edd,
	0x1ede: 0x1001ede,
	0x1edf: 0x1001edf,
	0x1ee0: 0x1001ee0,
	0x1ee1: 0x1001ee1,
	0x1ee2: 0x1001ee2,
	0x1ee3: 0x1001ee3,
	0x1ee4: 0x1001ee4,
	0x1ee5: 0x1001ee5,
	0x1ee6: 0x1001ee6,
	0x1ee7: 0x1001ee7,
	0x1ee8: 0x1001ee8,
	0x1ee9: 0x1001ee9,
	0x1eea: 0x1001eea,
	0x1eeb: 0x1001eeb,
	0x1eec: 0x1001eec,
	0x1eed: 0x1001eed,
	0x1eee: 0x1001eee,
	0x1eef: 0x1001eef,
	0x1ef0: 0x1001ef0,
	0x1ef1: 0x1001ef1,
	0x1ef4: 0x1001ef4,
	0x1ef5: 0x1001ef5,
	0x1ef6: 0x1001ef6,
	0x1ef7: 0x1001ef7,
	0x1ef8: 0x1001ef8,
	0x1ef9: 0x1001ef9,
	0x01a0: 0x10001a0,
	0x01a1: 0x10001a1,
	0x01af: 0x10001af,
	0x01b0: 0x10001b0,
	0x20a0: 0x10020a0,
	0x20a1: 0x10020a1,
	0x20a2: 0x10020a2,
	0x20a3: 0x10020a3,
	0x20a4: 0x10020a4,
	0x20a5: 0x10020a5,
	0x20a6: 0x10020a6,
	0x20a7: 0x10020a7,
	0x20a8: 0x10020a8,
	0x20a9: 0x10020a9,
	0x20aa: 0x10020aa,
	0x20ab: 0x10020ab,
	0x20ac: 0x20ac,
	0x2070: 0x1002070,
	0x2074: 0x1002074,
	0x2075: 0x1002075,
	0x2076: 0x1002076,
	0x2077: 0x1002077,
	0x2078: 0x1002078,
	0x2079: 0x1002079,
	0x2080: 0x1002080,
	0x2081: 0x1002081,
	0x2082: 0x1002082,
	0x2083: 0x1002083,
	0x2084: 0x1002084,
	0x2085: 0x1002085,
	0x2086: 0x1002086,
	0x2087: 0x1002087,
	0x2088: 0x1002088,
	0x2089: 0x1002089,
	0x2202: 0x1002202,
	0x2205: 0x1002205,
	0x2208: 0x1002208,
	0x2209: 0x1002209,
	0x220b: 0x100220b,
	0x221a: 0x100221a,
	0x221b: 0x100221b,
	0x221c: 0x100221c,
	0x222c: 0x100222c,
	0x222d: 0x100222d,
	0x2235: 0x1002235,
	0x2245: 0x1002248,
	0x2247: 0x1002247,
	0x2262: 0x1002262,
	0x2263: 0x1002263,
	0x2800: 0x1002800,
	0x2801: 0x1002801,
	0x2802: 0x1002802,
	0x2803: 0x1002803,
	0x2804: 0x1002804,
	0x2805: 0x1002805,
	0x2806: 0x1002806,
	0x2807: 0x1002807,
	0x2808: 0x1002808,
	0x2809: 0x1002809,
	0x280a: 0x100280a,
	0x280b: 0x100280b,
	0x280c: 0x100280c,
	0x280d: 0x100280d,
	0x280e: 0x100280e,
	0x280f: 0x100280f,
	0x2810: 0x1002810,
	0x2811: 0x1002811,
	0x2812: 0x1002812,
	0x2813: 0x1002813,
	0x2814: 0x1002814,
	0x2815: 0x1002815,
	0x2816: 0x1002816,
	0x2817: 0x1002817,
	0x2818: 0x1002818,
	0x2819: 0x1002819,
	0x281a: 0x100281a,
	0x281b: 0x100281b,
	0x281c: 0x100281c,
	0x281d: 0x100281d,
	0x281e: 0x100281e,
	0x281f: 0x100281f,
	0x2820: 0x1002820,
	0x2821: 0x1002821,
	0x2822: 0x1002822,
	0x2823: 0x1002823,
	0x2824: 0x1002824,
	0x2825: 0x1002825,
	0x2826: 0x1002826,
	0x2827: 0x1002827,
	0x2828: 0x1002828,
	0x2829: 0x1002829,
	0x282a: 0x100282a,
	0x282b: 0x100282b,
	0x282c: 0x100282c,
	0x282d: 0x100282d,
	0x282e: 0x100282e,
	0x282f: 0x100282f,
	0x2830: 0x1002830,
	0x2831: 0x1002831,
	0x2832: 0x1002832,
	0x2833: 0x1002833,
	0x2834: 0x1002834,
	0x2835: 0x1002835,
	0x2836: 0x1002836,
	0x2837: 0x1002837,
	0x2838: 0x1002838,
	0x2839: 0x1002839,
	0x283a: 0x100283a,
	0x283b: 0x100283b,
	0x283c: 0x100283c,
	0x283d: 0x100283d,
	0x283e: 0x100283e,
	0x283f: 0x100283f,
	0x2840: 0x1002840,
	0x2841: 0x1002841,
	0x2842: 0x1002842,
	0x2843: 0x1002843,
	0x2844: 0x1002844,
	0x2845: 0x1002845,
	0x2846: 0x1002846,
	0x2847: 0x1002847,
	0x2848: 0x1002848,
	0x2849: 0x1002849,
	0x284a: 0x100284a,
	0x284b: 0x100284b,
	0x284c: 0x100284c,
	0x284d: 0x100284d,
	0x284e: 0x100284e,
	0x284f: 0x100284f,
	0x2850: 0x1002850,
	0x2851: 0x1002851,
	0x2852: 0x1002852,
	0x2853: 0x1002853,
	0x2854: 0x1002854,
	0x2855: 0x1002855,
	0x2856: 0x1002856,
	0x2857: 0x1002857,
	0x2858: 0x1002858,
	0x2859: 0x1002859,
	0x285a: 0x100285a,
	0x285b: 0x100285b,
	0x285c: 0x100285c,
	0x285d: 0x100285d,
	0x285e: 0x100285e,
	0x285f: 0x100285f,
	0x2860: 0x1002860,
	0x2861: 0x1002861,
	0x2862: 0x1002862,
	0x2863: 0x1002863,
	0x2864: 0x1002864,
	0x2865: 0x1002865,
	0x2866: 0x1002866,
	0x2867: 0x1002867,
	0x2868: 0x1002868,
	0x2869: 0x1002869,
	0x286a: 0x100286a,
	0x286b: 0x100286b,
	0x286c: 0x100286c,
	0x286d: 0x100286d,
	0x286e: 0x100286e,
	0x286f: 0x100286f,
	0x2870: 0x1002870,
	0x2871: 0x1002871,
	0x2872: 0x1002872,
	0x2873: 0x1002873,
	0x2874: 0x1002874,
	0x2875: 0x1002875,
	0x2876: 0x1002876,
	0x2877: 0x1002877,
	0x2878: 0x1002878,
	0x2879: 0x1002879,
	0x287a: 0x100287a,
	0x287b: 0x100287b,
	0x287c: 0x100287c,
	0x287d: 0x100287d,
	0x287e: 0x100287e,
	0x287f: 0x100287f,
	0x2880: 0x1002880,
	0x2881: 0x1002881,
	0x2882: 0x1002882,
	0x2883: 0x1002883,
	0x2884: 0x1002884,
	0x2885: 0x1002885,
	0x2886: 0x1002886,
	0x2887: 0x1002887,
	0x2888: 0x1002888,
	0x2889: 0x1002889,
	0x288a: 0x100288a,
	0x288b: 0x100288b,
	0x288c: 0x100288c,
	0x288d: 0x100288d,
	0x288e: 0x100288e,
	0x288f: 0x100288f,
	0x2890: 0x1002890,
	0x2891: 0x1002891,
	0x2892: 0x1002892,
	0x2893: 0x1002893,
	0x2894: 0x1002894,
	0x2895: 0x1002895,
	0x2896: 0x1002896,
	0x2897: 0x1002897,
	0x2898: 0x1002898,
	0x2899: 0x1002899,
	0x289a: 0x100289a,
	0x289b: 0x100289b,
	0x289c: 0x100289c,
	0x289d: 0x100289d,
	0x289e: 0x100289e,
	0x289f: 0x100289f,
	0x28a0: 0x10028a0,
	0x28a1: 0x10028a1,
	0x28a2: 0x10028a2,
	0x28a3: 0x10028a3,
	0x28a4: 0x10028a4,
	0x28a5: 0x10028a5,
	0x28a6: 0x10028a6,
	0x28a7: 0x10028a7,
	0x28a8: 0x10028a8,
	0x28a9: 0x10028a9,
	0x28aa: 0x10028aa,
	0x28ab: 0x10028ab,
	0x28ac: 0x10028ac,
	0x28ad: 0x10028ad,
	0x28ae: 0x10028ae,
	0x28af: 0x10028af,
	0x28b0: 0x10028b0,
	0x28b1: 0x10028b1,
	0x28b2: 0x10028b2,
	0x28b3: 0x10028b3,
	0x28b4: 0x10028b4,
	0x28b5: 0x10028b5,
	0x28b6: 0x10028b6,
	0x28b7: 0x10028b7,
	0x28b8: 0x10028b8,
	0x28b9: 0x10028b9,
	0x28ba: 0x10028ba,
	0x28bb: 0x10028bb,
	0x28bc: 0x10028bc,
	0x28bd: 0x10028bd,
	0x28be: 0x10028be,
	0x28bf: 0x10028bf,
	0x28c0: 0x10028c0,
	0x28c1: 0x10028c1,
	0x28c2: 0x10028c2,
	0x28c3: 0x10028c3,
	0x28c4: 0x10028c4,
	0x28c5: 0x10028c5,
	0x28c6: 0x10028c6,
	0x28c7: 0x10028c7,
	0x28c8: 0x10028c8,
	0x28c9: 0x10028c9,
	0x28ca: 0x10028ca,
	0x28cb: 0x10028cb,
	0x28cc: 0x10028cc,
	0x28cd: 0x10028cd,
	0x28ce: 0x10028ce,
	0x28cf: 0x10028cf,
	0x28d0: 0x10028d0,
	0x28d1: 0x10028d1,
	0x28d2: 0x10028d2,
	0x28d3: 0x10028d3,
	0x28d4: 0x10028d4,
	0x28d5: 0x10028d5,
	0x28d6: 0x10028d6,
	0x28d7: 0x10028d7,
	0x28d8: 0x10028d8,
	0x28d9: 0x10028d9,
	0x28da: 0x10028da,
	0x28db: 0x10028db,
	0x28dc: 0x10028dc,
	0x28dd: 0x10028dd,
	0x28de: 0x10028de,
	0x28df: 0x10028df,
	0x28e0: 0x10028e0,
	0x28e1: 0x10028e1,
	0x28e2: 0x10028e2,
	0x28e3: 0x10028e3,
	0x28e4: 0x10028e4,
	0x28e5: 0x10028e5,
	0x28e6: 0x10028e6,
	0x28e7: 0x10028e7,
	0x28e8: 0x10028e8,
	0x28e9: 0x10028e9,
	0x28ea: 0x10028ea,
	0x28eb: 0x10028eb,
	0x28ec: 0x10028ec,
	0x28ed: 0x10028ed,
	0x28ee: 0x10028ee,
	0x28ef: 0x10028ef,
	0x28f0: 0x10028f0,
	0x28f1: 0x10028f1,
	0x28f2: 0x10028f2,
	0x28f3: 0x10028f3,
	0x28f4: 0x10028f4,
	0x28f5: 0x10028f5,
	0x28f6: 0x10028f6,
	0x28f7: 0x10028f7,
	0x28f8: 0x10028f8,
	0x28f9: 0x10028f9,
	0x28fa: 0x10028fa,
	0x28fb: 0x10028fb,
	0x28fc: 0x10028fc,
	0x28fd: 0x10028fd,
	0x28fe: 0x10028fe,
	0x28ff: 0x10028ff,
};

var ON_KEYDOWN = 1 << 0; /* Report on keydown, otherwise wait until keypress  */

var specialKeyTable = {
	// These generate a keyDown and keyPress in Firefox and Opera
	8: [0xff08, ON_KEYDOWN], // BACKSPACE
	13: [0xff0d, ON_KEYDOWN], // ENTER

	// This generates a keyDown and keyPress in Opera
	9: [0xff09, ON_KEYDOWN], // TAB

	27: 0xff1b, // ESCAPE
	46: 0xffff, // DELETE
	36: 0xff50, // HOME
	35: 0xff57, // END
	33: 0xff55, // PAGE_UP
	34: 0xff56, // PAGE_DOWN
	45: 0xff63, // INSERT
	37: 0xff51, // LEFT
	38: 0xff52, // UP
	39: 0xff53, // RIGHT
	40: 0xff54, // DOWN
	16: 0xffe1, // SHIFT
	17: 0xffe3, // CONTROL
	18: 0xffe9, // Left ALT (Mac Command)
	112: 0xffbe, // F1
	113: 0xffbf, // F2
	114: 0xffc0, // F3
	115: 0xffc1, // F4
	116: 0xffc2, // F5
	117: 0xffc3, // F6
	118: 0xffc4, // F7
	119: 0xffc5, // F8
	120: 0xffc6, // F9
	121: 0xffc7, // F10
	122: 0xffc8, // F11
	123: 0xffc9, // F12
};

function getEventKeySym(ev) {
	if (typeof ev.which !== "undefined" && ev.which > 0) return ev.which;
	return ev.keyCode;
}

// This is based on the approach from noVNC. We handle
// everything in keydown that we have all info for, and that
// are not safe to pass on to the browser (as it may do something
// with the key. The rest we pass on to keypress so we can get the
// translated keysym.
function getKeysymSpecial(ev) {
	if (ev.keyCode in specialKeyTable) {
		var r = specialKeyTable[ev.keyCode];
		var flags = 0;
		if (typeof r != "number") {
			flags = r[1];
			r = r[0];
		}
		if (ev.type === "keydown" || flags & ON_KEYDOWN) return r;
	}
	// If we don't hold alt or ctrl, then we should be safe to pass
	// on to keypressed and look at the translated data
	if (!ev.ctrlKey && !ev.altKey) return null;

	var keysym = getEventKeySym(ev);

	/* Remap symbols */
	switch (keysym) {
		case 186:
			keysym = 59;
			break; // ; (IE)
		case 187:
			keysym = 61;
			break; // = (IE)
		case 188:
			keysym = 44;
			break; // , (Mozilla, IE)
		case 109: // - (Mozilla, Opera)
			if (true /* TODO: check if browser is firefox or opera */) keysym = 45;
			break;
		case 189:
			keysym = 45;
			break; // - (IE)
		case 190:
			keysym = 46;
			break; // . (Mozilla, IE)
		case 191:
			keysym = 47;
			break; // / (Mozilla, IE)
		case 192:
			keysym = 96;
			break; // ` (Mozilla, IE)
		case 219:
			keysym = 91;
			break; // [ (Mozilla, IE)
		case 220:
			keysym = 92;
			break; // \ (Mozilla, IE)
		case 221:
			keysym = 93;
			break; // ] (Mozilla, IE)
		case 222:
			keysym = 39;
			break; // ' (Mozilla, IE)
	}

	/* Remap shifted and unshifted keys */
	if (!!ev.shiftKey) {
		switch (keysym) {
			case 48:
				keysym = 41;
				break; // ) (shifted 0)
			case 49:
				keysym = 33;
				break; // ! (shifted 1)
			case 50:
				keysym = 64;
				break; // @ (shifted 2)
			case 51:
				keysym = 35;
				break; // # (shifted 3)
			case 52:
				keysym = 36;
				break; // $ (shifted 4)
			case 53:
				keysym = 37;
				break; // % (shifted 5)
			case 54:
				keysym = 94;
				break; // ^ (shifted 6)
			case 55:
				keysym = 38;
				break; // & (shifted 7)
			case 56:
				keysym = 42;
				break; // * (shifted 8)
			case 57:
				keysym = 40;
				break; // ( (shifted 9)
			case 59:
				keysym = 58;
				break; // : (shifted `)
			case 61:
				keysym = 43;
				break; // + (shifted ;)
			case 44:
				keysym = 60;
				break; // < (shifted ,)
			case 45:
				keysym = 95;
				break; // _ (shifted -)
			case 46:
				keysym = 62;
				break; // > (shifted .)
			case 47:
				keysym = 63;
				break; // ? (shifted /)
			case 96:
				keysym = 126;
				break; // ~ (shifted `)
			case 91:
				keysym = 123;
				break; // { (shifted [)
			case 92:
				keysym = 124;
				break; // | (shifted \)
			case 93:
				keysym = 125;
				break; // } (shifted ])
			case 39:
				keysym = 34;
				break; // " (shifted ')
		}
	} else if (keysym >= 65 && keysym <= 90) {
		/* Remap unshifted A-Z */
		keysym += 32;
	} else if (ev.keyLocation === 3) {
		// numpad keys
		switch (keysym) {
			case 96:
				keysym = 48;
				break; // 0
			case 97:
				keysym = 49;
				break; // 1
			case 98:
				keysym = 50;
				break; // 2
			case 99:
				keysym = 51;
				break; // 3
			case 100:
				keysym = 52;
				break; // 4
			case 101:
				keysym = 53;
				break; // 5
			case 102:
				keysym = 54;
				break; // 6
			case 103:
				keysym = 55;
				break; // 7
			case 104:
				keysym = 56;
				break; // 8
			case 105:
				keysym = 57;
				break; // 9
			case 109:
				keysym = 45;
				break; // -
			case 110:
				keysym = 46;
				break; // .
			case 111:
				keysym = 47;
				break; // /
		}
	}

	return keysym;
}

/* Translate DOM keyPress event to keysym value */
function getKeysym(ev) {
	var keysym, msg;

	keysym = getEventKeySym(ev);

	if (keysym > 255 && keysym < 0xff00) {
		// Map Unicode outside Latin 1 to gdk keysyms
		keysym = unicodeTable[keysym];
		if (typeof keysym === "undefined") keysym = 0;
	}

	return keysym;
}

function copyKeyEvent(ev) {
	var members = [
			"type",
			"keyCode",
			"charCode",
			"which",
			"altKey",
			"ctrlKey",
			"shiftKey",
			"keyLocation",
			"keyIdentifier",
		],
		i,
		obj = {};
	for (i = 0; i < members.length; i++) {
		if (typeof ev[members[i]] !== "undefined") obj[members[i]] = ev[members[i]];
	}
	return obj;
}

function pushKeyEvent(fev) {
	keyDownList.push(fev);
}

function getKeyEvent(keyCode, pop) {
	var i,
		fev = null;
	for (i = keyDownList.length - 1; i >= 0; i--) {
		if (keyDownList[i].keyCode === keyCode) {
			if (typeof pop !== "undefined" && pop) fev = keyDownList.splice(i, 1)[0];
			else fev = keyDownList[i];
			break;
		}
	}
	return fev;
}

function ignoreKeyEvent(ev) {
	// Blarg. Some keys have a different keyCode on keyDown vs keyUp
	if (ev.keyCode === 229) {
		// French AZERTY keyboard dead key.
		// Lame thing is that the respective keyUp is 219 so we can't
		// properly ignore the keyUp event
		return true;
	}
	return false;
}

function handleKeyDown(e) {
	var fev = null,
		ev = e ? e : window.event,
		keysym = null,
		suppress = false;

	fev = copyKeyEvent(ev);

	keysym = getKeysymSpecial(ev);
	// Save keysym decoding for use in keyUp
	fev.keysym = keysym;
	if (keysym) {
		// If it is a key or key combination that might trigger
		// browser behaviors or it has no corresponding keyPress
		// event, then send it immediately
		if (!ignoreKeyEvent(ev)) sendInput("k", [keysym, lastState]);
		suppress = true;
	}

	if (!ignoreKeyEvent(ev)) {
		// Add it to the list of depressed keys
		pushKeyEvent(fev);
	}

	if (suppress) {
		// Suppress bubbling/default actions
		return cancelEvent(ev);
	}

	// Allow the event to bubble and become a keyPress event which
	// will have the character code translated
	return true;
}

function handleKeyPress(e) {
	var ev = e ? e : window.event,
		kdlen = keyDownList.length,
		keysym = null;

	if ((ev.which !== "undefined" && ev.which === 0) || getKeysymSpecial(ev)) {
		// Firefox and Opera generate a keyPress event even if keyDown
		// is suppressed. But the keys we want to suppress will have
		// either:
		// - the which attribute set to 0
		// - getKeysymSpecial() will identify it
		return cancelEvent(ev);
	}

	keysym = getKeysym(ev);

	// Modify the which attribute in the depressed keys list so
	// that the keyUp event will be able to have the character code
	// translation available.
	if (kdlen > 0) {
		keyDownList[kdlen - 1].keysym = keysym;
	} else {
		//log("keyDownList empty when keyPress triggered");
	}

	// Send the translated keysym
	if (keysym > 0) sendInput("k", [keysym, lastState]);

	// Stop keypress events just in case
	return cancelEvent(ev);
}

function handleKeyUp(e) {
	var fev = null,
		ev = e ? e : window.event,
		i,
		keysym;

	fev = getKeyEvent(ev.keyCode, true);

	if (fev) keysym = fev.keysym;
	else {
		//log("Key event (keyCode = " + ev.keyCode + ") not found on keyDownList");
		keysym = 0;
	}

	if (keysym > 0) sendInput("K", [keysym, lastState]);
	return cancelEvent(ev);
}

function onKeyDown(ev) {
	updateForEvent(ev);
	return handleKeyDown(ev);
}

function onKeyPress(ev) {
	updateForEvent(ev);
	return handleKeyPress(ev);
}

function onKeyUp(ev) {
	updateForEvent(ev);
	return handleKeyUp(ev);
}

function cancelEvent(ev) {
	ev = ev ? ev : window.event;
	// we dont want to disable event in web-desktop-environment
	// if (ev.stopPropagation) ev.stopPropagation();
	// if (ev.preventDefault) ev.preventDefault();
	// ev.cancelBubble = true;
	// ev.cancel = true;
	// ev.returnValue = false;
	// return false;
}

function onMouseWheel(ev) {
	updateForEvent(ev);
	ev = ev ? ev : window.event;

	var id = getSurfaceId(ev);
	var pos = getPositionsFromEvent(ev, id);

	var offset = ev.detail ? ev.detail : -ev.wheelDelta;
	var dir = 0;
	if (offset > 0) dir = 1;
	sendInput("s", [
		realWindowWithMouse,
		id,
		pos.rootX,
		pos.rootY,
		pos.winX,
		pos.winY,
		lastState,
		dir,
	]);

	return cancelEvent(ev);
}

function onTouchStart(ev) {

	updateKeyboardStatus();
	updateForEvent(ev);

	for (var i = 0; i < ev.changedTouches.length; i++) {
		var touch = ev.changedTouches.item(i);

		var origId = getSurfaceId(touch);
		var id = getEffectiveEventTarget(origId);
		var pos = getPositionsFromEvent(touch, id);
		var isEmulated = 0;

		if (firstTouchDownId == null) {
			firstTouchDownId = touch.identifier;
			isEmulated = 1;

			if (realWindowWithMouse != origId || id != windowWithMouse) {
				if (id != 0) {
					sendInput("l", [
						realWindowWithMouse,
						id,
						pos.rootX,
						pos.rootY,
						pos.winX,
						pos.winY,
						lastState,
						GDK_CROSSING_NORMAL,
					]);
				}

				windowWithMouse = id;
				realWindowWithMouse = origId;

				sendInput("e", [
					origId,
					id,
					pos.rootX,
					pos.rootY,
					pos.winX,
					pos.winY,
					lastState,
					GDK_CROSSING_NORMAL,
				]);
			}
		}

		sendInput("t", [
			0,
			id,
			touch.identifier,
			isEmulated,
			pos.rootX,
			pos.rootY,
			pos.winX,
			pos.winY,
			lastState,
		]);
	}
}

function onTouchMove(ev) {

	updateKeyboardStatus();
	updateForEvent(ev);

	for (var i = 0; i < ev.changedTouches.length; i++) {
		var touch = ev.changedTouches.item(i);

		var origId = getSurfaceId(touch);
		var id = getEffectiveEventTarget(origId);
		var pos = getPositionsFromEvent(touch, id);

		var isEmulated = 0;
		if (firstTouchDownId == touch.identifier) {
			isEmulated = 1;
		}

		sendInput("t", [
			1,
			id,
			touch.identifier,
			isEmulated,
			pos.rootX,
			pos.rootY,
			pos.winX,
			pos.winY,
			lastState,
		]);
	}
}

function onTouchEnd(ev) {

	updateKeyboardStatus();
	updateForEvent(ev);

	for (var i = 0; i < ev.changedTouches.length; i++) {
		var touch = ev.changedTouches.item(i);

		var origId = getSurfaceId(touch);
		var id = getEffectiveEventTarget(origId);
		var pos = getPositionsFromEvent(touch, id);

		var isEmulated = 0;
		if (firstTouchDownId == touch.identifier) {
			isEmulated = 1;
			firstTouchDownId = null;
		}

		sendInput("t", [
			2,
			id,
			touch.identifier,
			isEmulated,
			pos.rootX,
			pos.rootY,
			pos.winX,
			pos.winY,
			lastState,
		]);
	}
}

function setupDocument(document) {
	document.oncontextmenu = function () {
		return false;
	};
	// document.onmousemove = onMouseMove;
	// document.onmouseover = onMouseOver;
	// document.onmouseout = onMouseOut;
	// document.onmousedown = onMouseDown;
	// document.onmouseup = onMouseUp;
	// document.onkeydown = onKeyDown;
	// document.onkeypress = onKeyPress;
	// document.onkeyup = onKeyUp;

	if (document.addEventListener) {
		document.addEventListener("mousemove", onMouseMove, false);
		document.addEventListener("mouseover", onMouseOver, false);
		document.addEventListener("mousedown", onMouseDown, false);
		document.addEventListener("mouseup", onMouseUp, false);
		document.addEventListener("keydown", onKeyDown, false);
		document.addEventListener("keypress", onKeyPress, false);
		document.addEventListener("keyup", onKeyUp, false);

		document.addEventListener("DOMMouseScroll", onMouseWheel, false);
		document.addEventListener("mousewheel", onMouseWheel, false);
		document.addEventListener("touchstart", onTouchStart, false);
		document.addEventListener("touchmove", onTouchMove, false);
		document.addEventListener("touchend", onTouchEnd, false);
	} else if (document.attachEvent) {
		element.attachEvent("onmousewheel", onMouseWheel);
	}
}

function start() {
	setupDocument(document);

	var w, h;
	w = window.innerWidth;
	h = window.innerHeight;
	window.onresize = function (ev) {
		var w, h;
		w = window.innerWidth;
		h = window.innerHeight;
		sendInput("d", [w, h]);
	};
	sendInput("d", [w, h]);
}


export function connect(host, https, port) {
	const ws = new WebSocket(
		`${https ? "wss" : "ws"}://${host}:${port}/socket`,
		"broadway"
	);
	GTKBridgeEmitter.call("status", "connecting");
	ws.binaryType = "arraybuffer";

	ws.onopen = function () {
		GTKBridgeEmitter.call("status", "connected");
		inputSocket = ws;
	};
	ws.onclose = function () {
		if (inputSocket != null) {
			GTKBridgeEmitter.call("status", "disconnected");
			rootDiv.innerHTML = "";
		}
		inputSocket = null;
	};
	ws.onmessage = function (event) {
		handleMessage(event.data);
	};

	var iOS = /(iPad|iPhone|iPod)/g.test(navigator.userAgent);
	if (iOS) {
		fakeInput = document.createElement("input");
		fakeInput.type = "text";
		fakeInput.style.position = "absolute";
		fakeInput.style.left = "-1000px";
		fakeInput.style.top = "-1000px";
		rootDiv.appendChild(fakeInput);
	}
}

window.stopGDK = () => (active = false);
