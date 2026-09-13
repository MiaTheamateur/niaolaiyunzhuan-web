(function () {
  "use strict";

  var PREFIX = "NYNZ2";
  var LEGACY_PREFIX = "NYNZ1";

  function atomIdToToken(id) {
    var match = /^src-(\d{3})(?:-(\d{2}))?$/.exec(id);
    if (!match) return "";
    var serial = Number.parseInt(match[1], 10);
    var child = match[2] ? Number.parseInt(match[2], 10) : 0;
    return (serial * 100 + child).toString(36);
  }

  function tokenToAtomId(token) {
    var value = Number.parseInt(token, 36);
    if (!Number.isFinite(value) || value < 100) return "";
    var serial = Math.floor(value / 100);
    var child = value % 100;
    var serialText = String(serial).padStart(3, "0");
    return child ? "src-" + serialText + "-" + String(child).padStart(2, "0") : "src-" + serialText;
  }

  function encodeIdList(ids) {
    return ids.map(atomIdToToken).filter(Boolean).sort(function (left, right) {
      return Number.parseInt(left, 36) - Number.parseInt(right, 36);
    }).join(".");
  }

  function decodeIdList(value) {
    if (!value) return [];
    return value.split(".").map(tokenToAtomId).filter(Boolean);
  }

  function checksum(value) {
    var hash = 2166136261;
    for (var index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  function encode(options) {
    var createdAt = Number.isFinite(options.createdAt) ? options.createdAt : Date.now();
    var body = [
      PREFIX,
      createdAt.toString(36),
      encodeIdList(options.completedIds || []),
      encodeIdList(options.seenNewIds || []),
    ].join("|");
    return body + "|" + checksum(body);
  }

  function decode(payload) {
    var parts = String(payload || "").trim().split("|");
    if (parts.length !== 5 || (parts[0] !== PREFIX && parts[0] !== LEGACY_PREFIX)) throw new Error("这不是袅来运转生成的备份图");
    var body = parts.slice(0, 4).join("|");
    if (checksum(body) !== parts[4]) throw new Error("备份图校验失败，请选择清晰的原图");
    var createdAt = Number.parseInt(parts[1], 36);
    if (!Number.isFinite(createdAt)) throw new Error("备份时间无法识别");
    return {
      schemaVersion: parts[0] === PREFIX ? 2 : 1,
      createdAt: createdAt,
      completedIds: decodeIdList(parts[2]),
      seenNewIds: decodeIdList(parts[3]),
    };
  }

  function roundedRect(context, x, y, width, height, radius) {
    var right = x + width;
    var bottom = y + height;
    context.beginPath();
    context.moveTo(x + radius, y);
    context.lineTo(right - radius, y);
    context.quadraticCurveTo(right, y, right, y + radius);
    context.lineTo(right, bottom - radius);
    context.quadraticCurveTo(right, bottom, right - radius, bottom);
    context.lineTo(x + radius, bottom);
    context.quadraticCurveTo(x, bottom, x, bottom - radius);
    context.lineTo(x, y + radius);
    context.quadraticCurveTo(x, y, x + radius, y);
    context.closePath();
  }

  function drawQr(context, payload, x, y, availableSize) {
    if (typeof window.qrcode !== "function") throw new Error("二维码生成组件未加载");
    var qr = window.qrcode(0, "M");
    qr.addData(payload, "Byte");
    qr.make();
    var moduleCount = qr.getModuleCount();
    var cellSize = Math.floor(availableSize / moduleCount);
    var qrSize = cellSize * moduleCount;
    var offsetX = x + Math.floor((availableSize - qrSize) / 2);
    var offsetY = y + Math.floor((availableSize - qrSize) / 2);

    context.fillStyle = "#ffffff";
    context.fillRect(x, y, availableSize, availableSize);
    context.fillStyle = "#172943";
    for (var row = 0; row < moduleCount; row += 1) {
      for (var column = 0; column < moduleCount; column += 1) {
        if (qr.isDark(row, column)) {
          context.fillRect(offsetX + column * cellSize, offsetY + row * cellSize, cellSize, cellSize);
        }
      }
    }
  }

  function drawBackupImage(payload, summary) {
    var canvas = document.createElement("canvas");
    canvas.width = 900;
    canvas.height = 1180;
    var context = canvas.getContext("2d");
    var gradient = context.createLinearGradient(0, 0, 900, 1180);
    gradient.addColorStop(0, "#fff8e7");
    gradient.addColorStop(1, "#ffe8a9");
    context.fillStyle = gradient;
    context.fillRect(0, 0, 900, 1180);

    context.fillStyle = "rgba(255, 255, 255, 0.88)";
    roundedRect(context, 56, 52, 788, 1076, 38);
    context.fill();
    context.strokeStyle = "#e5bd61";
    context.lineWidth = 3;
    context.stroke();

    context.fillStyle = "#d85a0e";
    context.font = "700 28px -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif";
    context.fillText("袅来运转", 104, 118);
    context.fillStyle = "#172943";
    context.font = "800 50px -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif";
    context.fillText("袅袅进度备份", 104, 184);
    context.fillStyle = "#6b7180";
    context.font = "400 24px -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif";
    context.fillText("已记录 " + summary.completedCount + " 项", 104, 230);
    context.textAlign = "right";
    context.fillText(summary.createdAtLabel, 796, 230);
    context.textAlign = "left";

    drawQr(context, payload, 126, 274, 648);

    context.fillStyle = "#173f7c";
    context.font = "700 28px -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif";
    context.textAlign = "center";
    context.fillText("请保留原图，用于恢复进度", 450, 984);
    context.fillStyle = "#6b7180";
    context.font = "400 22px -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif";
    context.fillText("打开小工具，选择“恢复记录”并选取此图", 450, 1030);
    context.fillText("备份只含勾选状态，不含账号或隐私信息", 450, 1070);
    context.textAlign = "left";
    return canvas.toDataURL("image/png");
  }

  function decodeImageFile(file) {
    return new Promise(function (resolve, reject) {
      if (!file || !/^image\//i.test(file.type || "")) {
        reject(new Error("请选择备份图片"));
        return;
      }
      if (typeof window.jsQR !== "function") {
        reject(new Error("二维码识别组件未加载"));
        return;
      }

      var reader = new FileReader();
      reader.onerror = function () { reject(new Error("无法读取所选图片")); };
      reader.onload = function () {
        var image = new Image();
        image.onerror = function () { reject(new Error("所选图片无法识别")); };
        image.onload = function () {
          try {
            var longest = Math.max(image.naturalWidth, image.naturalHeight);
            var scale = longest > 1800 ? 1800 / longest : 1;
            var canvas = document.createElement("canvas");
            canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
            canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
            var context = canvas.getContext("2d");
            context.drawImage(image, 0, 0, canvas.width, canvas.height);
            var pixels = context.getImageData(0, 0, canvas.width, canvas.height);
            var result = window.jsQR(pixels.data, canvas.width, canvas.height, { inversionAttempts: "attemptBoth" });
            if (!result || !result.data) throw new Error("没有识别到备份二维码，请选择清晰的原图");
            resolve(decode(result.data));
          } catch (error) {
            reject(error);
          }
        };
        image.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  window.NIAONIAO_BACKUP = {
    encode: encode,
    decode: decode,
    drawBackupImage: drawBackupImage,
    decodeImageFile: decodeImageFile,
  };
})();
