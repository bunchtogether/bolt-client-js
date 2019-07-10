// @flow

import EventEmitter from 'events';
import CaptionParser from 'mux.js/lib/mp4/caption-parser';
import mp4Probe from 'mux.js/lib/mp4/probe';
import Mp4Frag from 'mp4frag';
import { parseBuffer } from 'codem-isoboxer';
import LruCache from 'lru-cache';
import request from 'request';
import makeBoltLogger from './logger';

const Cue = window.VTTCue || window.TextTrackCue;

const isFirefox = navigator.userAgent.match(/Firefox\//);

const MOOF = Buffer.from([0x6D, 0x6F, 0x6F, 0x66]);
const MP4A = Buffer.from([0x6d, 0x70, 0x34, 0x61]);
const AVCC = Buffer.from([0x61, 0x76, 0x63, 0x43]);

const mergeUint8Arrays = (arrays) => {
  let length = 0;
  arrays.forEach((item) => {
    length += item.length;
  });
  const merged = new Uint8Array(length);
  let offset = 0;
  arrays.forEach((item) => {
    merged.set(item, offset);
    offset += item.length;
  });
  return merged;
};

/**
 * Class representing a Blend Client
 */
export default class BoltPubSubClient extends EventEmitter {
  constructor(element: HTMLVideoElement, streamUrl:string, baseUrl:string, ipfs:Object) {
    super();
    this.element = element;
    this.ipfs = ipfs;
    this.baseUrl = baseUrl;
    this.textTracks = new Map();
    this.textCache = new LruCache({ max: 500 });
    this.streamUrl = streamUrl;
    this.videoQueue = [];
    this.resetInProgress = false;
    this.reconnectAttempt = 0;
    this.reconnectAttemptResetTimeout = null;
    const clientLogger = makeBoltLogger(`${streamUrl} Client`);
    this.videoLogger = makeBoltLogger(`${streamUrl} Video Element`);
    this.mediaSourceLogger = makeBoltLogger(`${streamUrl} Media Source`);
    this.videoBufferLogger = makeBoltLogger(`${streamUrl} Video Source Buffer`);
    this.pubSubLogger = makeBoltLogger(`${streamUrl} PubSub`);
    this.setupElementLogging(element);
    this.ready = this.openPubSub(streamUrl);
    this.ready.catch((error) => {
      this.pubSubLogger.error(error.message);
    });
    element.addEventListener('error', (event:Event) => {
      if (event.type !== 'error') {
        return;
      }
      const mediaError = element.error;
      if (mediaError && mediaError.code === mediaError.MEDIA_ERR_DECODE) {
        // this.emit('error', mediaError);
        this.reset();
      }
    });
    let nextBufferedSegmentInterval;
    const skipToNextBufferedSegment = () => {
      const videoBuffer = this.videoBuffer;
      if (!videoBuffer) {
        return;
      }
      for (let i = 0; i < videoBuffer.buffered.length; i += 1) {
        const segmentStart = videoBuffer.buffered.start(i);
        if (segmentStart > element.currentTime) {
          this.videoLogger.warn(`Skipping ${segmentStart - element.currentTime} ms`);
          element.currentTime = segmentStart; // eslint-disable-line no-param-reassign
          return;
        }
      }
    };
    const addEnsureRecoveryOnWaiting = () => {
      element.addEventListener('waiting', () => {
        ensureRecovery();
        if (!this.videoBuffer) {
          return;
        }
        clearInterval(nextBufferedSegmentInterval);
        nextBufferedSegmentInterval = setInterval(() => {
          skipToNextBufferedSegment();
        }, 100);
        skipToNextBufferedSegment();
      });
      element.removeEventListener('canplay', addEnsureRecoveryOnWaiting);
      element.removeEventListener('playing', addEnsureRecoveryOnWaiting);
      element.removeEventListener('play', addEnsureRecoveryOnWaiting);
    };
    element.addEventListener('canplay', addEnsureRecoveryOnWaiting);
    element.addEventListener('playing', addEnsureRecoveryOnWaiting);
    element.addEventListener('play', addEnsureRecoveryOnWaiting);
    element.addEventListener('canplay', () => {
      clearInterval(nextBufferedSegmentInterval);
      element.play();
    });
    const elementIsPlaying = () => {
      if (!element) {
        return false;
      }
      return !!(element.currentTime > 0 && !element.paused && !element.ended && element.readyState > 2);
    };
    this.recoveryTimeout = null;
    const ensureRecovery = () => {
      if (this.reconnectAttemptResetTimeout) {
        clearTimeout(this.reconnectAttemptResetTimeout);
      }
      if (elementIsPlaying()) {
        clientLogger.info('Element is playing, skipping recovery detection');
        return;
      }
      if (this.recoveryTimeout || this.resetInProgress) {
        clientLogger.info('Recovery detection already in progress, skipping');
        return;
      }
      clientLogger.info('Ensuring recovery after error detected');
      const recoveryStart = Date.now();
      const handlePlay = () => {
        clientLogger.info(`Recovered after ${Math.round((Date.now() - recoveryStart) / 100) / 10} seconds`);
        if (this.recoveryTimeout) {
          clearTimeout(this.recoveryTimeout);
        }
        this.recoveryTimeout = null;
        element.removeEventListener('playing', handlePlay);
        this.reconnectAttemptResetTimeout = setTimeout(() => {
          this.reconnectAttempt = 0;
        }, 15000);
      };
      clientLogger.info(`Reconnect attempt: ${this.reconnectAttempt}`);
      if (this.reconnectAttempt > 3) {
        clientLogger.info(`Attempting to play fallback stream after ${this.reconnectAttempt} attempts`);
        // Emit message to handle fallback url
        this.emit('handleFallbackStream', { });
        this.reconnectAttempt = 0;
      }
      this.recoveryTimeout = setTimeout(() => {
        if (elementIsPlaying()) {
          clientLogger.info('Detected playing element after recovery timeout');
          handlePlay();
          return;
        }
        this.recoveryTimeout = null;
        clientLogger.error('Timeout after attempted recovery');
        this.reset();
        element.removeEventListener('playing', handlePlay);
      }, 60000);
      element.addEventListener('playing', handlePlay);
    };
  }

  async close() {
    if (this.recoveryTimeout) {
      clearTimeout(this.recoveryTimeout);
    }
    this.element.removeAttribute('src');
    this.element.load();
    try {
      await this.closePubSub();
    } catch (error) {
      console.log(`Error closing PubSub: ${error.message}`); // eslint-disable-line no-console
    }
    delete this.videoBuffer;
    this.videoQueue = [];
  }

  async reset() {
    if (this.resetInProgress) {
      return;
    }
    this.resetInProgress = true;
    await this.close();
    this.resetInProgress = false;
    this.reconnectAttempt += 1;
    this.openPubSub(this.streamUrl);
  }

  /**
   * Connects to a server.
   * @param {string} address Stream URL
   * @return {Promise<void>}
   */
  async openPubSub(streamUrl:string) {
    const captionParser = new CaptionParser();

    captionParser.init();

    let trackIds;
    let timescales;
    // let buffered = new Uint8Array([]);
    const [initSegment, mimetype] = await new Promise((resolve, reject) => {
      console.log(`${this.baseUrl}/init-${encodeURIComponent(streamUrl)}.mp4`);
      request.get(`${this.baseUrl}/init-${encodeURIComponent(streamUrl)}.mp4`, { encoding: null }, (error, response, body) => {
        if (error) {
          reject(error);
        } else {
          let audioString = '';
          if (body.indexOf(MP4A) !== -1) {
            audioString = ', mp4a.40.2';
          }
          let index = body.indexOf(AVCC);
          if (index === -1) {
            reject(new Error(`${AVCC.toString()} codec info not found.`));
            return;
          }
          index += 5;
          resolve([body, `video/mp4; codecs="avc1.${body.slice(index, index + 3).toString('hex').toUpperCase()}${audioString}"`]);
        }
      });
    });
    this.setupMediaSource(this.element, mimetype);
    const videoBuffer = this.videoBuffer;
    const videoQueue = this.videoQueue;
    if (videoBuffer) {
      if (videoQueue.length > 0 || videoBuffer.updating) {
        videoQueue.push(initSegment);
      } else {
        try {
          videoBuffer.appendBuffer(initSegment);
        } catch (error) {
          this.videoBufferLogger.error(`${error.message}, code: ${error.code}`);
        }
      }
    } else {
      videoQueue.push(initSegment);
    }
    const foundFirstMoof = false;
    const messageDataQueue = [];
    const seqno = Buffer.from([0]);
    await this.ipfs.pubsub.subscribe(streamUrl, (message) => {
      // messageDataQueue.push(message);
      // if(seqno > message.seqno) {
      //  console.log("OUT OF ORDER");
      //  messageDataQueue.sort((x, y) => x.seqno > y.seqno ? -1 : 1);
      // }
      // seqno = message.seqno;
      // captionParser.clearParsedCaptions();
      // const buffered = mergeUint8Arrays(messageDataQueue.map((x) => x.data));
      // if(!foundFirstMoof) {
      //  const index = buffered.indexOf(MOOF);
      //  if (index > 3 && buffered.length > index + 3) {
      //    console.log(`FOUND MOOF at ${index}`);
      //    buffered = buffered.slice(index - 4);
      //    foundFirstMoof = true;
      //  } else {
      //    console.log("DID NOT FIND MOOF");
      //    return;
      //  }
      // }
      // const parsed = parseBuffer(buffered.buffer);
      // if (parsed._incomplete) { // eslint-disable-line no-underscore-dangle
      //  return;
      // }
      // messageDataQueue = [];
      // console.log("COMPLETE");
      // if (!trackIds || !timescales) {
      //   const checkedTimescales = mp4Probe.timescale(buffered);
      //   if (Object.keys(checkedTimescales).length === 0) {
      //     return;
      //   }
      //   timescales = checkedTimescales;
      //   trackIds = mp4Probe.videoTrackIds(buffered);
      // }
      // const parsedCaptions = captionParser.parse(buffered, trackIds, timescales);
      // if (parsedCaptions) {
      //  const { captions } = parsedCaptions;
      //  for (const caption of captions) {
      //    this.addCaption(caption);
      //  }
      // }
      const videoBuffer = this.videoBuffer;
      const videoQueue = this.videoQueue;
      if (videoBuffer) {
        if (videoQueue.length > 0 || videoBuffer.updating) {
          videoQueue.push(message.data);
        } else {
          try {
            videoBuffer.appendBuffer(message.data);
          } catch (error) {
            this.videoBufferLogger.error(`${error.message}, code: ${error.code}`);
          }
        }
      } else {
        videoQueue.push(message.data);
      }
      // buffered = new Uint8Array([]);
    });
  }

  addCaption({ stream, startTime, endTime, text }: { stream:string, startTime:number, endTime:number, text:string }) {
    if (this.textCache.has(text)) {
      return;
    }
    this.textCache.set(text, true);
    let textTrack = this.textTracks.get(stream);
    if (!textTrack) {
      textTrack = this.element.addTextTrack('captions', 'English', 'en');
      this.textTracks.set(stream, textTrack);
    }
    const cue = new Cue(startTime, endTime, text);
    cue.line = 1;
    cue.align = 'left';
    cue.position = isFirefox ? 55 : 5;
    textTrack.addCue(cue);
  }

  async closePubSub() {
    await this.ipfs.pubsub.unsubscribe(this.streamUrl);
  }

  async setupMediaSource(element: HTMLVideoElement, mimetype: string) {
    const mediaSource = new MediaSource();
    this.setupMediaSourceLogging(mediaSource);
    element.src = URL.createObjectURL(mediaSource); // eslint-disable-line no-param-reassign
    await new Promise((resolve) => {
      const handle = () => {
        mediaSource.removeEventListener('sourceopen', handle);
        resolve();
      };
      mediaSource.addEventListener('sourceopen', handle);
    });
    const videoBuffer = mediaSource.addSourceBuffer(mimetype);
    this.videoBuffer = videoBuffer;
    this.setupVideoBufferLogging(videoBuffer);
    videoBuffer.addEventListener('updateend', async () => {
      if (this.videoQueue.length > 0 && !videoBuffer.updating) {
        try {
          videoBuffer.appendBuffer(this.videoQueue.shift());
        } catch (error) {
          this.videoBufferLogger.error(`${error.message}, code: ${error.code}`);
        }
      }
    });
    if (this.videoQueue.length > 0 && !videoBuffer.updating) {
      try {
        const data = mergeUint8Arrays(this.videoQueue);
        this.videoQueue = [];
        videoBuffer.appendBuffer(data);
      } catch (error) {
        this.videoBufferLogger.error(`${error.message}, code: ${error.code}`);
      }
    }
  }

  setupMediaSourceLogging(mediaSource: MediaSource) {
    const mediaSourceLogger = this.mediaSourceLogger;
    mediaSource.addEventListener('sourceopen', () => {
      mediaSourceLogger.info('sourceopen');
    });
    mediaSource.addEventListener('sourceended', () => {
      mediaSourceLogger.info('sourceended');
    });
    mediaSource.addEventListener('sourceclose', () => {
      mediaSourceLogger.info('sourceclose');
    });
    mediaSource.addEventListener('updatestart', () => {
      mediaSourceLogger.info('updatestart');
    });
    mediaSource.addEventListener('update', () => {
      mediaSourceLogger.info('update');
    });
    mediaSource.addEventListener('updateend', () => {
      mediaSourceLogger.info('updateend');
    });
    mediaSource.addEventListener('error', () => {
      mediaSourceLogger.info('error');
    });
    mediaSource.addEventListener('abort', () => {
      mediaSourceLogger.info('abort');
    });
    mediaSource.addEventListener('addsourcevideoBuffer', () => {
      mediaSourceLogger.info('addsourcevideoBuffer');
    });
    mediaSource.addEventListener('removesourcevideoBuffer', () => {
      mediaSourceLogger.info('removesourcevideoBuffer');
    });
  }

  setupVideoBufferLogging(videoBuffer: SourceBuffer) {
    const videoBufferLogger = this.videoBufferLogger;
    videoBuffer.addEventListener('sourceopen', () => {
      videoBufferLogger.info('sourceopen');
    });
    videoBuffer.addEventListener('sourceended', () => {
      videoBufferLogger.info('sourceended');
    });
    videoBuffer.addEventListener('sourceclose', () => {
      videoBufferLogger.info('sourceclose');
    });
    videoBuffer.addEventListener('error', () => {
      videoBufferLogger.info('error');
    });
    videoBuffer.addEventListener('abort', () => {
      videoBufferLogger.info('abort');
    });
    videoBuffer.addEventListener('addsourcevideoBuffer', () => {
      videoBufferLogger.info('addsourcevideoBuffer');
    });
    videoBuffer.addEventListener('removesourcevideoBuffer', () => {
      videoBufferLogger.info('removesourcevideoBuffer');
    });
  }

  setupElementLogging(element: HTMLVideoElement) {
    const videoLogger = this.videoLogger;
    element.addEventListener('resize', () => {
      videoLogger.info('abort', 'Sent when playback is aborted; for example, if the media is playing and is restarted from the beginning, this event is sent');
    });
    element.addEventListener('canplay', () => {
      videoLogger.info('canplay', 'Sent when enough data is available that the media can be played, at least for a couple of frames.  This corresponds to the HAVE_ENOUGH_DATA readyState');
    });
    element.addEventListener('canplaythrough', () => {
      videoLogger.info('canplaythrough', 'Sent when the ready state changes to CAN_PLAY_THROUGH, indicating that the entire media can be played without interruption, assuming the download rate remains at least at the current level. It will also be fired when playback is toggled between paused and playing. Note: Manually setting the currentTime will eventually fire a canplaythrough event in firefox. Other browsers might not fire this event');
    });
    element.addEventListener('durationchange', () => {
      videoLogger.info('durationchange', 'The metadata has loaded or changed, indicating a change in duration of the media.  This is sent, for example, when the media has loaded enough that the duration is known');
    });
    element.addEventListener('emptied', () => {
      videoLogger.info('emptied', 'The media has become empty; for example, this event is sent if the media has already been loaded (or partially loaded), and the load() method is called to reload it');
    });
    element.addEventListener('encrypted', () => {
      videoLogger.info('encrypted', ' The user agent has encountered initialization data in the media data');
    });
    element.addEventListener('ended', () => {
      videoLogger.info('ended', 'Sent when playback completes');
    });
    element.addEventListener('error', (event:ProgressEvent) => {
      const mediaError = element.error;
      const message = mediaError && mediaError.message ? mediaError.message : null;
      if (mediaError && message) {
        videoLogger.error(`${mediaError.code}: ${message}`);
      } else {
        videoLogger.error('error', 'Sent when an error occurs.  The element\'s error attribute contains more information. See HTMLMediaElement.error for details');
        if (event) {
          videoLogger.error(event);
        }
      }
    });
    element.addEventListener('interruptbegin', () => {
      videoLogger.info('interruptbegin', 'Sent when audio playing on a Firefox OS device is interrupted, either because the app playing the audio is sent to the background, or audio in a higher priority audio channel begins to play. See Using the AudioChannels API for more details');
    });
    element.addEventListener('interruptend', () => {
      videoLogger.info('interruptend', 'Sent when previously interrupted audio on a Firefox OS device commences playing again — when the interruption ends. This is when the associated app comes back to the foreground, or when the higher priority audio finished playing. See Using the AudioChannels API for more details');
    });
    element.addEventListener('loadeddata', () => {
      videoLogger.info('loadeddata', 'The first frame of the media has finished loading');
    });
    element.addEventListener('loadedmetadata', () => {
      videoLogger.info('loadedmetadata', 'The media\'s metadata has finished loading; all attributes now contain as much useful information as they\'re going to');
    });
    element.addEventListener('loadstart', () => {
      videoLogger.info('loadstart', 'Sent when loading of the media begins');
    });
    element.addEventListener('mozaudioavailable', () => {
      videoLogger.info('mozaudioavailable', 'Sent when an audio videoBuffer is provided to the audio layer for processing; the videoBuffer contains raw audio samples that may or may not already have been played by the time you receive the event');
    });
    element.addEventListener('pause', () => {
      videoLogger.info('pause', 'Sent when the playback state is changed to paused (paused property is true)');
    });
    element.addEventListener('play', () => {
      videoLogger.info('play', 'Sent when the playback state is no longer paused, as a result of the play method, or the autoplay attribute');
    });
    element.addEventListener('playing', () => {
      videoLogger.info('playing', 'Sent when the media has enough data to start playing, after the play event, but also when recovering from being stalled, when looping media restarts, and after seeked, if it was playing before seeking');
    });
    element.addEventListener('ratechange', () => {
      videoLogger.info('ratechange', 'Sent when the playback speed changes');
    });
    element.addEventListener('seeked', () => {
      videoLogger.info('seeked', 'Sent when a seek operation completes');
    });
    element.addEventListener('seeking', () => {
      videoLogger.info('seeking', 'Sent when a seek operation begins');
    });
    element.addEventListener('stalled', () => {
      videoLogger.info('stalled', 'Sent when the user agent is trying to fetch media data, but data is unexpectedly not forthcoming');
    });
    element.addEventListener('suspend', () => {
      videoLogger.info('suspend', 'Sent when loading of the media is suspended; this may happen either because the download has completed or because it has been paused for any other reason');
    });
    element.addEventListener('volumechange', () => {
      videoLogger.info('volumechange', 'Sent when the audio volume changes (both when the volume is set and when the muted attribute is changed)');
    });
    element.addEventListener('waiting', () => {
      videoLogger.info('waiting', 'Sent when the requested operation (such as playback) is delayed pending the completion of another operation (such as a seek)');
    });
  }

  id:string;
  ipfs: Object;
  baseUrl: string;
  element: HTMLVideoElement;
  resetInProgress: boolean;
  reconnectAttempt: number;
  reconnectAttemptResetTimeout: TimeoutID | null;
  videoBuffer: SourceBuffer;
  streamUrl:string;
  ready: Promise<void>;
  videoLogger: Object;
  mediaSourceLogger: Object;
  videoBufferLogger: Object;
  pubSubLogger: Object;
  videoQueue:Array<Uint8Array>;
  ready: Promise<void>;
  textTracks: Map<string, TextTrack>;
  textCache: LruCache<string, boolean>;
  recoveryTimeout: TimeoutID | null;
}
