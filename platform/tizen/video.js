var confirmDelay = 800 // confirm player status after this delay
var Player = function(ui) {
	var player = ui._context.createElement("object")
	player.dom.setAttribute("id", "av-player")
	player.dom.setAttribute("type", "application/avplayer")
	if (!window.webapis) {
		log('"webapis" is undefined, maybe <script src="$WEBAPIS/webapis/webapis.js"></script> is missed.')
		return
	}
	this._webapis = window.webapis
	log("WEBAPIS", this._webapis)

	this.ui = ui

	ui.element.remove()
	ui.element = player
	ui.parent.element.append(ui.element)

	var self = this
	ui.setNotSuspendFlag = function(value) { self._notSuspend = value }.bind(this)
	var context = ui._context
	this._listener = {
		onbufferingstart : this.wrapCallback(function() {
			self.ui.waiting = true
			self.ui.seeking = true
		}),
		onbufferingprogress : this.wrapCallback(function(percent) {
			context._processActions()
		}),
		onbufferingcomplete : this.wrapCallback(function() {
			self.ui.seeking = false
			self.ui.waiting = false
			// confirm avplay internal state after buffering completes
			self._syncAvplayState();
		}),
		oncurrentplaytime : this.wrapCallback(function(currentTime) {
			if (currentTime) self.ui.waiting = false
			self.ui.ready = true
			if(!self.ui.seeking){
				self.updateCurrentTime(currentTime);
			}
			// when we receive current time, likely playback started — sync state
			self._syncAvplayState();
		}),
		onevent : this.wrapCallback(function(eventType, eventData) {
			log("event type: " + eventType + ", data: " + eventData);
		}),
		onerror : this.wrapCallback(function(eventType) {
			log("error type: " + eventType);
			self.ui.ready = false
			self.ui.error({ "type": eventType, "message": eventType })
			self.againPlay()
		}),
		onsubtitlechange : this.wrapCallback(function(duration, text, data3, data4) {
			log("Subtitle Changed.");
			self.ui.text(text, duration, data4)
		}),
		ondrmevent : this.wrapCallback(function(drmEvent, drmData) {
			log("DRM callback: " + drmEvent + ", data: " + JSON.stringify(drmData));
			var avplay = self.getAVPlay()
			avplay.setDrm("PLAYREADY", "InstallLicense", JSON.stringify(self._drmParam));
		}),
		onstreamcompleted : this.wrapCallback(function(e) {
			if (ui.progress < ui.duration - 1) {
				log("Unexpected ending error occured")
				self.ui.error({
					"type": "PLAYER_ERROR_UNEXPECTED_ENDING",
					"message": "Unexpected ending. Progress is " + ui.progress + " but duration is " + ui.duration
				})
				return
			}

			if (self.ui.loop) {
				log("Video is looped play it again")
				var avplay = self.getAVPlay()
				avplay.seekTo(0)
			} else {
				log("Stream Completed");
				self.ui.ready = false
				// mark paused-like (ended) and sync
				self.ui.paused = true;
				self._syncAvplayState();
				self.ui.finished()
			}
		})
	};

	var tizen = window.tizen
	if (tizen && tizen.systeminfo)
		tizen.systeminfo.getPropertyValue("BUILD", this.fillDeviceInfo.bind(this));
}


Player.prototype.againPlay = function() {
	var self = this
	self.fetchMasterManifest(self.ui.source, function(data){	
		var url = self.parseMasterManifest(data.content).videoUrl
		var baseurl = self.getBaseUrl(self.ui.source)
		self.ui.source = baseurl+url
		self.playImpl()
	})
}

Player.prototype.fetchMasterManifest = function (m3u8Url, callback) {
	var xhr = new XMLHttpRequest();
	xhr.open("GET", m3u8Url, true);
	xhr.onload = function() {
		if (xhr.status >= 200 && xhr.status < 300) {
		var manifestText = xhr.responseText;	
		callback({
			content: manifestText,
			url: m3u8Url
		});
		} else {
		callback(new Error("Request failed with status: " + xhr.status));
		}
	};
	xhr.onerror = function() {
		callback(new Error("Request failed"));
	};
	xhr.send();
}

Player.prototype.parseMasterManifest = function (manifestText) {
	var lines = manifestText.split("\n");
	var videoUrl = null;
	var subtitlesUrl = null;

	for (var i = 0; i < lines.length; i++) {
		var line = lines[i].trim();
		// Ищем URL субтитров (ES5-совместимый вариант)
		if (line.indexOf("#EXT-X-MEDIA:TYPE=SUBTITLES") === 0) {
		var uriMatch = /URI="([^"]+)"/.exec(line);
		if (uriMatch && uriMatch[1]) {
			subtitlesUrl = uriMatch[1];
		}}
		// Ищем видео-поток
		if (line.indexOf("#EXT-X-STREAM-INF:") === 0) {
		if (i + 1 < lines.length && lines[i + 1].trim() && lines[i + 1].trim().indexOf("#") !== 0) {
			videoUrl = lines[i + 1].trim();
		}}
	}

	return {
		videoUrl: videoUrl,
		subtitlesUrl: subtitlesUrl
	};
};

Player.prototype.getBaseUrl = function (fullUrl) {
	// Проверяем, есть ли query-параметры
	var queryIndex = fullUrl.indexOf("?");
	var urlWithoutQuery = queryIndex !== -1 
		? fullUrl.substring(0, queryIndex) 
		: fullUrl;
	// Находим последний слэш перед именем файла
	var lastSlashIndex = urlWithoutQuery.lastIndexOf("/");
	if (lastSlashIndex !== -1) {
		return urlWithoutQuery.substring(0, lastSlashIndex + 1);
	}
	return fullUrl; // Если слэшей нет, возвращаем как есть
}

Player.prototype.fillDeviceInfo = function(device) {
	log("Fill deviceinfo in player", device)
	if (device && device.model) {
		var modelName = device.model.toLowerCase()
		var webapis = window.webapis
		log("Device modelName", modelName)
		if (webapis && webapis.productinfo) {
			this._uhdSupported = webapis.productinfo.isUdPanelSupported()
		} else {
			log("productinfo is undefined try to retrive UHD support flag from modelname")
			var checkUhdSubName = function(sub) { return modelName.indexOf(sub) >= 0 }
			this._uhdSupported = checkUhdSubName("mu") || checkUhdSubName("ks") || checkUhdSubName("ku") || checkUhdSubName("hu")
		}
	} else {
		this._uhdSupported = false
	}
}

Player.prototype.wrapCallback = function(callback) {
	return this.ui._context.wrapNativeCallback(callback)
}

Player.prototype.getAVPlay = function() {
	var webapis = this._webapis
	return webapis && webapis.avplay ? webapis.avplay : null
}

Player.prototype.setSource = function(value) {
	log("src", value)
	this.ui.ready = false
	log("drmRequired", this._drmRequired)
	if (this._drmRequired && this._drm)
		this._drmRequired = false
	else
		this._drm = null

	if (this._suspendState) {
		this._suspendState.url = value
		this._suspendState.progress = this.ui.startPosition
	}
	this.playImpl()
}

Player.prototype.playImpl = function() {
	var avplay = this.getAVPlay()
	if (!avplay) {
		log("AVPlay was not initialized")
		return
	}
	var ui = this.ui
	if (!ui.source)
		return
	var state = avplay.getState()
	log("playImpl", state, "src", ui.source)

	if (state != "NONE")
		this.closeVideo()

	log("playImpl", ui.source, "state", state)
	ui.duration = 0
	log("playImpl open")
	avplay.open(ui.source);
	log("playImpl setListener")
	avplay.setListener(this._listener);
	log("Init player, src:", ui.source, "width:", ui.width, "height:", ui.height)
	log("DRM:", this._drm)
	if (this._drm) {
		log("Apply DRM:", this._drm);
		var drm = this._drm
		if (drm.widevine) {
			var deviceId = window.webapis.drminfo.getEsn("WIDEVINE");
			var licenseServer = drm.widevine.laServer;
			this._drmParam = "DEVICE_ID=" + deviceId + "|DEVICE_TYPE_ID=60|STREAM_ID=|IP_ADDR=|DRM_URL=" + licenseServer + "|PORTAL=OEM|I_SEEK=|CUR_TIME=|USER_DATA=";
			avplay.setStreamingProperty("WIDEVINE", this._drmParam);
			avplay.setDrm("WIDEVINE", "SetProperties", JSON.stringify(this._drmParam));
		} else if (drm.playready) {
			this._drmParam = { LicenseServer: drm.playready.laServer };
			avplay.setDrm("PLAYREADY", "SetProperties", JSON.stringify(this._drmParam));
		}
	}
	avplay.setDisplayRect(ui.x, ui.y, ui.width, ui.height);
	log("Set UHD flag", this._uhdSupported, "allowUhdPlaying", ui.allowUhdPlaying, "startPos", ui.startPosition)
	avplay.setStreamingProperty("SET_MODE_4K", ui.allowUhdPlaying && this._uhdSupported ? "TRUE" : "FALSE");
	avplay.setDisplayMethod("PLAYER_DISPLAY_MODE_FULL_SCREEN");

	if (ui.startPosition)
		avplay.seekTo(ui.startPosition * 1000, function() { log("seeked on start") }, function(err) { log("failed to seek on start",err) });

	log("playImpl prepare")
	var self = this
	avplay.prepareAsync(function() {
		log("Current state: " + avplay.getState());
		log("prepare complete source", ui.source);
		self.updateDuration()
		ui.ready = (avplay.getState() === "READY");
		if (ui.autoPlay) {
			self.play();
		} else {
			self._syncAvplayState();
		}
	});
}

Player.prototype._syncAvplayState = function() {
	try {
		var avplay = this.getAVPlay();
		if (!avplay || !this.ui) return;
		var s = avplay.getState();
		// keep mapping you use for paused
		this.ui.paused = (s === "PAUSED" || s === "STOPPED" || s === "NONE" || s === "IDLE");
	} catch (e) {
		log("syncAvplayState error", e);
	}
}

Player.prototype.play = function() {
	var self = this;
	var avplay = self.getAVPlay()
	if (!avplay) {
		log("AVPlay was not initialized")
		return
	}
	log("Play Video", self.ui.source);
	try {
		avplay.play();
		self.ui.paused = false;
		setTimeout(function() {
			self._syncAvplayState();
		}, confirmDelay);

		log("Play invoked. getState:", avplay.getState());
	} catch (e) {
		log(e);
		// try to sync state on exception
		self._syncAvplayState();
	}
}

Player.prototype.setupDrm = function(type, options, callback, error) {
	if (type === "widevine") {
		this._drm = {}
		this._drm["widevine"] = options
	} else if (type === "playready") {
		this._drm = {}
		this._drm["playready"] = options
	} else {
		error ? error(new Error("Unkbown or not supported DRM type " + type)) : log("Unkbown or not supported DRM type " + type)
	}

	var avplay = this.getAVPlay()
	var drm = this._drm
	log("Apply DRM:", this._drm);
	if (callback)
		callback()
}

Player.prototype.getVideoTracks = function() {
	var video = [ { "name": "auto", "id": "auto" } ]
	var avplay = this.getAVPlay()
	var tracks = avplay.getTotalTrackInfo()

	for (var i = 0; i < tracks.length; ++i) {
		var track = tracks[i]
		if (track.type !== "VIDEO")
			continue

		var info = JSON.parse(track.extra_info)
		video.push({
			id: parseInt(track.index),
			width: parseInt(info.Width),
			height: parseInt(info.Height)
		})
	}
	return video
}

Player.prototype.getSubtitles = function() {
	var subtitles = []
	subtitles.push({
		id: "off",
		label: "Выкл",
		active: true
	})
	var avplay = this.getAVPlay()
	var tracks = avplay.getTotalTrackInfo()

	for (var i = 0; i < tracks.length; ++i) {
		var track = tracks[i]
		if (track.type !== "TEXT")
			continue

		var info = JSON.parse(track.extra_info)

		subtitles.push({
			id: parseInt(track.index),
			label: "Русский",
			language: info.track_lang
		})
	}
	log("Got subtitles", JSON.stringify(subtitles))
	return subtitles
}

Player.prototype.getAudioTracks = function() {
	var audio = []
	var avplay = this.getAVPlay()
	var tracks = avplay.getTotalTrackInfo()

	for (var i = 0; i < tracks.length; ++i) {
		var track = tracks[i]
		if (track.type !== "AUDIO")
			continue

		var info = JSON.parse(track.extra_info)
		audio.push({
			id: parseInt(track.index),
			language: info.language,
			bitRate: parseInt(info.bit_rate),
			codec: info.fourCC
		})
	}
	return audio
}

Player.prototype.setSubtitles = function(trackId) {
	var avplay = this.getAVPlay()
	var tracks = avplay.getTotalTrackInfo()

	var found = tracks.filter(function(element) {
		return parseInt(element.index) === trackId
	})

	log("Try to set subtitles", found)
	if (found && found.length)
		avplay.setSelectTrack("TEXT", parseInt(found[0].index));
}

Player.prototype.setAudioTrack = function(trackId) {
	var avplay = this.getAVPlay()
	var tracks = avplay.getTotalTrackInfo()

	var found = tracks.filter(function(element) {
		return parseInt(element.index) === trackId
	})

	log("Try to set audio track", found)
	if (found && found.length) {
		log("Seek after audio state", avplay.getState())
		avplay.setSelectTrack("AUDIO", parseInt(found[0].index));
		this.seek(1)
	}
}

Player.prototype.setVideoTrack = function(trackId) {
	log("setVideoTrack for", trackId)
	var avplay = this.getAVPlay()
	var tracks = avplay.getTotalTrackInfo()
	log("Total tracks", tracks)

	if (trackId === "auto") {
		var bitRateString = "BITRATES=5000~50000|STARTBITRATE=HIGHEST|SKIPBITRATE=LOWEST"
		try {
			avplay.setStreamingProperty("ADAPTIVE_INFO", bitRateString)
		} catch(e) {
			log("Failed to cahgne bitrate", e)
		}

	} else {
		var found = tracks.filter(function(element) {
			return parseInt(element.index) === trackId
		})

		log("Found", found)
		if (!found || !found.length)
			return
		var info = JSON.parse(found[0].extra_info)
		var bitRateString = "BITRATES=5000~" + info.Bit_rate + "|STARTBITRATE=HIGHEST|SKIPBITRATE=LOWEST";
		log("Found info", bitRateString, "INFO", info)
		try {
			avplay.setStreamingProperty("ADAPTIVE_INFO", bitRateString)
		} catch(e) {
			log("Failed to cahgne bitrate", e)
		}
	}
	var prevProgress = this.ui.progress
	avplay.close();
	this.playImpl();
	if (prevProgress > 12)
		this.seekTo(prevProgress)
}

Player.prototype.setVisibility = function(visible) {
	var avplay = this.getAVPlay()
	if (!avplay) {
		log("AVPlay was not initialized")
		return
	}

	log("setVisibility", visible, "state", avplay.getState(), "notsuspend", this._notSuspend)
	if (this._notSuspend)
		return

	if (visible) {
		log("Check suspend state", this._suspendState)
		if (this._suspendState) {
			var state = this._suspendState
			try {
				avplay.restore(state.url, state.progress * 1000)
			} catch (e) {
				log("Failed to restore")
			}
		}
		this._suspendState = null
	} else {
		try {
			this._suspendState = {
				progress: this.ui.progress,
				url: this.ui.source
			}
			avplay.suspend()
		} catch (e) {
			log("Failed to suspend avplay", e)
		}
	}
}

Player.prototype.pause = function() {
	var self = this;
	var avplay = self.getAVPlay()
	if (!avplay) {
		log("AVPlay was not initialized")
		return
	}

	log("Pause Video", avplay);
	try {
		avplay.pause();
		self.ui.paused = true;
		// confirm after delay
		setTimeout(function() {
			self._syncAvplayState();
		}, confirmDelay);
	} catch (e) {
		log(e);
		self._syncAvplayState();
	}
};

//missing API in VideoPlayer
Player.prototype.stop = function() {
	var self = this;
	var avplay = self.getAVPlay()
	if (!avplay) {
		log("AVPlay was not initialized")
		return
	}
	log("Stop Video");
	try {
		avplay.stop();
	} catch (e) {
		log("stop() error", e);
		self._syncState();
	} finally {
		self.ui.paused = true;
		self.ui.ready = false;
		setTimeout(function() {
			self._syncState();
		}, confirmDelay);
	}
}

Player.prototype.seek = function(delta) {
	this.seekTo(this.ui.progress + delta)
}

Player.prototype.seekTo = function(tp) {
	var avplay = this.getAVPlay()
	if (!avplay) {
		log("AVPlay was not initialized")
		return
	}
	log("Seek to", tp, this.ui.progress)
	this.ui.seeking = true
	this.ui.progress = tp
	avplay.seekTo(tp * 1000)
}

Player.prototype.setVolume = function(volume) {
	// TODO: its set to max the system volume
	// window.tizen.tvaudiocontrol.setVolume(volume)
}

Player.prototype.setMute = function(muted) {
	window.tizen.tvaudiocontrol.setMute(muted)
	this.ui.muted = muted
}

Player.prototype.setRect = function(l, t, r, b) {
	var avplay = this.getAVPlay()
	if (!avplay) {
		log("AVPlay was not initialized")
		return
	}
	avplay.setDisplayRect(l, t, r - l, b - t)
}

Player.prototype.setBackgroundColor = function(color) {
	log("Not implemented")
}

Player.prototype.setLoop = function(loop) {
	log("Not implemented")
}

Player.prototype.closeVideo = function() {
	var avplay = this.getAVPlay()
	if (!avplay) {
		log("AVPlay was not initialized")
		return
	}
	log("Current state: " + avplay.getState());
	log("Close Video");
	try {
		avplay.close();
		log("Current state: " + avplay.getState());
	} catch (e) {
		log("Current state: " + avplay.getState());
		log(e);
	}
}

Player.prototype.updateDuration = function() {
	var avplay = this.getAVPlay()
	if (!avplay) {
		log("AVPlay was not initialized")
		return
	}
	this.ui.duration = avplay.getDuration() / 1000
	log("Duration", this.ui.duration)
}

Player.prototype.setOption = function(name, value) {
}

Player.prototype.updateCurrentTime = function() {
	var avplay = this.getAVPlay()
	if (!avplay) {
		log("AVPlay was not initialized")
		return
	}
	this.ui.progress = avplay.getCurrentTime() / 1000
}

exports.createPlayer = function(ui) {
	return new Player(ui)
}

exports.probeUrl = function(url) {
	return 75
}
