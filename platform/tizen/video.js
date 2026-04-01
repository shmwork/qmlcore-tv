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
	this._preparing = false;			// prepareAsync в процессе
	this._pendingPlay = false;			// кто-то просил play во время _preparing
	this._pendingSeek = null;			// нужен для проброса  ui.startPosition
	this._seekingDebaunce = false
	this._seekTimer = null;				// таймер для дебаунса seekTo
	this._blockProgressUpdate = false	// блокирует updateCurrentTime, что бы избежать дергание ползунка
	this._seekStuckTimer = null; // таймер для проверки залипшего seek
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
			try {
				self.closeVideo()
			} catch(e) {
				log("close video fail", e)
			}
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
	if (!value) return
	this.ui.ready = false
	log("drmRequired", this._drmRequired)
	if (this._drmRequired && this._drm)
		this._drmRequired = false
	else
		this._drm = null

	// TODO: проверить работу suspend
	if (this._suspendState) {
		this._suspendState.url = value
		this._suspendState.progress = this.ui.startPosition
	}
	if (this._preparing) {
		log("aborting previous prepare and restarting");
		this.closeVideo()
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
	if (this._preparing) {
		log("playImpl: already preparing, skip");
		return;
	}
	var state = avplay.getState()
	if (state && state !== "NONE") {
		log("playImpl: closing existing");
		try {
			avplay.close()
		} catch (e) {
			log("close error", e)
		}
	}
	ui.duration = 0
	log("playImpl open")
	try {
		avplay.open(ui.source)
	} catch (e) {
		log("open error", e)
	}

	log("playImpl setListener")
	avplay.setListener(this._listener);
	log("Init player width:", ui.width, "height:", ui.height)
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

	// NOTE: вызовется в _startPrepare. После prepareAsync метод seekTo отрабатывает в два раза быстрее и становится асинхронным
	if (ui.startPosition) {
		this._pendingSeek = ui.startPosition;
		log("queued pending startPosition", this._pendingSeek);
	}
	this._startPrepare();
}

// NOTE: можно вызвать только если статус IDLE
Player.prototype._startPrepare = function() {
	var self = this;
	var avplay = self.getAVPlay();
	var ui = self.ui
	if (!avplay) return;
	if (this._preparing) {
		log("_startPrepare: already preparing");
		return;
	}
	this._preparing = true;
	try {
		avplay.prepareAsync(function() {
			// prepare success
			self._preparing = false
			switch (ui.mode) {
				case "vod":
					avplay.setDisplayMethod("PLAYER_DISPLAY_MODE_LETTER_BOX");
					break
				default:
					avplay.setDisplayMethod("PLAYER_DISPLAY_MODE_FULL_SCREEN");
			}
			self.updateDuration()
			ui.ready = (avplay.getState() === "READY");
			if (self._pendingSeek !== null) {
				log("startPosition queued, doing seek first", self._pendingSeek);
				// гарантия, что после seek будет запущен play
				self._pendingPlay = true;
				self._doSeek();
				return;
			}
			if (self._pendingPlay || ui.autoPlay) {
				self._pendingPlay = false;
				self._doPlay();
			} else {
				self._syncAvplayState();
			}
		}, function(err) {
			log("prepareError", err);
			self._preparing = false;
			self._pendingPlay = false;
			self._syncAvplayState();
		});
	} catch (e) {
		log("_startPrepare: prepareAsync err", e)
		this._preparing = false;
		this._syncAvplayState();
	}
};

// NOTE: можно вызвать только если статус READY
Player.prototype._doPlay = function() {
	var avplay = this.getAVPlay();
	var ui = this.ui;
	var self = this;
	if (!avplay) return
	try {
		avplay.play();
		ui.paused = false;
		setTimeout(function() {
			self._syncAvplayState();
		}, confirmDelay);
	} catch (e) {
		log("_doPlay: play() exception", e);
		this._syncAvplayState();
	}
};

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
	var avplay = this.getAVPlay()
	if (!avplay) {
		log("AVPlay was not initialized")
		return
	}
	var state = avplay.getState()
	if (state === "READY" || state === "PAUSED") {
		this._doPlay();
		return;
	}
	if (this._preparing) {
		log("play(): preparing in progress, set pendingPlay");
		this._pendingPlay = true;
		return;
	}
	// иначе делегируем в playImpl (он сделает open+prepare и по завершении запустит play, если нужен)
	this._pendingPlay = true; // просим автозапуск после prepare
	this.playImpl()
};

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
		label: "Выкл"
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
	// TODO: suspend режим
	// var avplay = this.getAVPlay()
	// if (!avplay) {
		// log("AVPlay was not initialized")
		// return
	// }

	// log("setVisibility", visible, "state", avplay.getState(), "notsuspend", this._notSuspend)
	// if (this._notSuspend)
		// return

	// if (visible) {
		// log("Check suspend state", this._suspendState)
		// if (this._suspendState) {
			// var state = this._suspendState
			// try {
				// avplay.restore(state.url, state.progress * 1000)
			// } catch (e) {
				// log("Failed to restore")
			// }
		// }
		// this._suspendState = null
	// } else {
		// try {
			// this._suspendState = {
				// progress: this.ui.progress,
				// url: this.ui.source
			// }
			// avplay.suspend()
		// } catch (e) {
			// log("Failed to suspend avplay", e)
		// }
	// }
}

Player.prototype.pause = function() {
	var self = this;
	var avplay = self.getAVPlay()
	if (!avplay) {
		log("AVPlay was not initialized")
		return
	}
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
		setTimeout(function() {
			avplay.closeVideo()
		}, 300)
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
	tp = Math.max(0, tp);
	// логика дебаунса
	this._pendingSeek = tp;
	if (this._seekTimer) {
		clearTimeout(this._seekTimer);
	}
	var self = this;
	this._seekTimer = setTimeout(function() {
		self._seekTimer = null;
		self._doSeek();
	}, 120);
};

Player.prototype._doSeek = function() {
	var avplay = this.getAVPlay();
	var self = this;
	if (!avplay) return;
	if (self._seekingDebaunce) {
		log("_doSeek: already seeking, pending will wait");
		return;
	}
	if (self._pendingSeek === null) return;
	var target = self._pendingSeek;
	self._pendingSeek = null;
	self._seekingDebaunce = true;
	self.ui.seeking = true;
	var ms = Math.floor(target * 1000);
	self._blockProgressUpdate = true;
	// NOTE: может быть кейс, при котором avplay.seekTo не вернет коллбеки. В таком случаи
	// не снимется _seekingDebaunce, из за чего последующая перемотка не будет работать
	if (self._seekStuckTimer) {
		clearTimeout(self._seekStuckTimer);
		self._seekStuckTimer = null;
	}
	self._seekStuckTimer = setTimeout(function() {
		if (self._seekingDebaunce) {
			log("_doSeek: seek seems stuck. Clearing _seekingDebaunce");
			self._seekingDebaunce = false;
			self.ui.seeking = false;
			self._blockProgressUpdate = false;
			self._syncAvplayState();
		}
		self._seekStuckTimer = null;
	}, 1500);

	try {
		avplay.seekTo(ms,
			function() { self._onSeekResult(null, target); },
			function(err) { self._onSeekResult(err, target); }
		);
	} catch (e) {
		log("_doSeek: seekTo threw", e);
		this._seekingDebaunce = false;
		this.ui.seeking = false;
		this._syncAvplayState();
		self._blockProgressUpdate = false;
		if (self._seekStuckTimer) {
			clearTimeout(self._seekStuckTimer)
			self._seekStuckTimer = null
		}
	}
	// блокируем обновление ui.progress, для того что бы избежать получение неправильного progress
	setTimeout(function() {
		self._blockProgressUpdate = false;
	}, 1500);
};

// замените существующую success-ветку в _onSeekResult на это
Player.prototype._onSeekResult = function(err, target) {
	var self = this;
	if (self._seekStuckTimer) {
		clearTimeout(self._seekStuckTimer);
		self._seekStuckTimer = null;
	}
	var avplay = this.getAVPlay();
	if (err) {
		log("_onSeekResult: error", err);
		this._seekingDebaunce = false;
		this.ui.seeking = false;
		if (this._pendingSeek !== null) {
			setTimeout(function(){
				self._doSeek()
			}, 200);
			return;
		}
		this._syncAvplayState();
		return;
	}
	this._seekingDebaunce = false;
	this.ui.seeking = false;
	this._seekRetry = 0;
	this.updateCurrentTime();
	// если пришёл новый seek — делаем его
	if (this._pendingSeek !== null) {
		setTimeout(function(){
			self._doSeek();
		}, 60);
		return;
	}
	// через небольшую задержку проверим состояние плеера и, если он не PLAYING, запускаем воспроизведение
	// это решает ситуацию, с остановившимся плеером, если установлен startPosition
	// NOTE: несмотря на то что _doSeek синхронный, avplay.getState() возвращает не актуальное состояние.
	// т.е. без таймера никуда
	setTimeout(function() {
		var state = avplay.getState()
		// если есть pendingPlay/autoPlay — гарантируем запуск
		if (self._pendingPlay || self.ui.autoPlay) {
			self._pendingPlay = false;
			try {
				// используем _doPlay чтобы сохранить единое поведение
				self._doPlay();
			} catch (e) {
				log("_onSeekResult: _doPlay error", e);
			}
			return;
		}
		if (state !== "PLAYING" && !self.ui.paused) {
			try {
				avplay.play();
				log("_onSeekResult: invoked avplay.play() after seek");
			} catch (e) {
				log("_onSeekResult: avplay.play() threw", e);
			}
		}
		self._syncAvplayState();
	}, 150);
};

Player.prototype.setVolume = function(volume) {
	// TODO: its set to max the system volume
	// window.tizen.tvaudiocontrol.setVolume(volume)
}

Player.prototype.setMute = function(muted) {
	window.tizen.tvaudiocontrol.setMute(muted)
	this.ui.muted = muted
}

Player.prototype.setRect = function(l, t, r, b) {
	// NOTE: вызывал проблему изменения соотношения сторон после остановки и воспроизведения
	// var avplay = this.getAVPlay()
	// if (!avplay) {
		// log("AVPlay was not initialized")
		// return
	// }
	// var st = avplay.getState();
	// log("@@set rect", st)
	// if (st === "IDLE" || st === "READY" || st === "PLAYING" || st === "PAUSED") {
		// avplay.setDisplayRect(l, t, r - l, b - t)
	// } else {
		// log("Can't set setDisplayRect, incorrect player state")
	// }
}

Player.prototype.setBackgroundColor = function(color) {
	log("Not implemented")
}

Player.prototype.setLoop = function(loop) {
	log("Not implemented")
}

Player.prototype.closeVideo = function() {
	var avplay = this.getAVPlay();
	if (!avplay) return;
	log("closeVideo: state:", avplay.getState());
	try {
		avplay.stop();
	} catch (e) {
		log("stop() failed", e);
	}
	try {
		avplay.close();
	} catch (e) {
		log("closeVideo: close error", e);
	}
	// сброс всех внутренних флагов/очередей/таймеров
	this._preparing = false;
	this._pendingPlay = false;
	this._pendingSeek = null;
	this._seekTimer && clearTimeout(this._seekTimer);
	this._seekTimer = null;
	this._seekingDebaunce = false;
	this._blockProgressUpdate = false;
	this._preparingStartedAt = 0;
};

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
	if (this._blockProgressUpdate) return
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
