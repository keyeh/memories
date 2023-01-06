import PhotoSwipe from "photoswipe";
import { loadState } from "@nextcloud/initial-state";
import axios from "@nextcloud/axios";
import { showError } from "@nextcloud/dialogs";
import { translate as t } from "@nextcloud/l10n";
import { getCurrentUser } from "@nextcloud/auth";

import { API } from "../../services/API";
import { IPhoto } from "../../types";

const config_noTranscode = loadState(
  "memories",
  "notranscode",
  <string>"UNSET"
) as boolean | string;

/**
 * Check if slide has video content
 *
 * @param {Slide|Content} content Slide or Content object
 * @returns Boolean
 */
function isVideoContent(content): boolean {
  return content?.data?.type === "video";
}

class VideoContentSetup {
  constructor(lightbox: PhotoSwipe, private options) {
    this.initLightboxEvents(lightbox);
    lightbox.on("init", () => {
      this.initPswpEvents(lightbox);
    });
  }

  initLightboxEvents(lightbox: PhotoSwipe) {
    lightbox.on("contentLoad", this.onContentLoad.bind(this));
    lightbox.on("contentDestroy", this.onContentDestroy.bind(this));
    lightbox.on("contentActivate", this.onContentActivate.bind(this));
    lightbox.on("contentDeactivate", this.onContentDeactivate.bind(this));
    lightbox.on("contentAppend", this.onContentAppend.bind(this));
    lightbox.on("contentResize", this.onContentResize.bind(this));

    lightbox.addFilter(
      "isKeepingPlaceholder",
      this.isKeepingPlaceholder.bind(this)
    );
    lightbox.addFilter("isContentZoomable", this.isContentZoomable.bind(this));
    lightbox.addFilter(
      "useContentPlaceholder",
      this.useContentPlaceholder.bind(this)
    );

    lightbox.addFilter("domItemData", (itemData, element, linkEl) => {
      return itemData;
    });
  }

  initPswpEvents(pswp: PhotoSwipe) {
    // Prevent draggin when pointer is in bottom part of the video
    // todo: add option for this
    pswp.on("pointerDown", (e) => {
      const slide = pswp.currSlide;
      if (isVideoContent(slide) && this.options.preventDragOffset) {
        const origEvent = e.originalEvent;
        if (origEvent.type === "pointerdown") {
          // Check if directly over the videojs control bar
          const elems = document.elementsFromPoint(
            origEvent.clientX,
            origEvent.clientY
          );
          if (elems.some((el) => el.classList.contains("plyr__controls"))) {
            e.preventDefault();
            return;
          }

          const videoHeight = Math.ceil(slide.height * slide.currZoomLevel);
          const verticalEnding = videoHeight + slide.bounds.center.y;
          const pointerYPos = origEvent.pageY - pswp.offset.y;
          if (
            pointerYPos > verticalEnding - this.options.preventDragOffset &&
            pointerYPos < verticalEnding
          ) {
            e.preventDefault();
          }
        }
      }
    });

    // do not append video on nearby slides
    pswp.on("appendHeavy", (e) => {
      if (isVideoContent(e.slide)) {
        const content = <any>e.slide.content;

        if (!e.slide.isActive) {
          e.preventDefault();
        } else if (content.videoElement) {
          this.initVideo(content);
        }
      }
    });

    pswp.on("close", () => {
      if (isVideoContent(pswp.currSlide.content)) {
        // prevent more requests
        this.destroyVideo(pswp.currSlide.content);
      }
    });
  }

  getHLSsrc(content: any) {
    // Get base URL
    const fileid = content.data.photo.fileid;
    return {
      src: API.VIDEO_TRANSCODE(fileid),
      type: "application/x-mpegURL",
    };
  }

  async initVideo(content: any) {
    if (!isVideoContent(content) || content.videojs) {
      return;
    }

    // Prevent double loading
    content.videojs = {};

    // Load videojs scripts
    if (!globalThis.vidjs) {
      await import("../../services/videojs");
    }

    // Create video element
    content.videoElement = document.createElement("video");
    content.videoElement.className = "video-js";
    content.videoElement.setAttribute("poster", content.data.msrc);
    if (this.options.videoAttributes) {
      for (let key in this.options.videoAttributes) {
        content.videoElement.setAttribute(
          key,
          this.options.videoAttributes[key] || ""
        );
      }
    }

    // Add the video element to the actual container
    content.element.appendChild(content.videoElement);

    // Create hls sources if enabled
    let sources: any[] = [];

    if (!config_noTranscode) {
      sources.push(this.getHLSsrc(content));
    }

    sources.push({
      src: content.data.src,
      type: "video/mp4",
    });

    const overrideNative = false;
    content.videojs = vidjs(content.videoElement, {
      fill: true,
      autoplay: true,
      sources: sources,
      preload: "metadata",
      responsive: true,
      html5: {
        vhs: {
          overrideNative: overrideNative,
          withCredentials: false,
        },
        nativeAudioTracks: !overrideNative,
        nativeVideoTracks: !overrideNative,
        nativeControlsForTouch: !overrideNative,
      },
    });

    content.videojs.on("error", () => {
      if (content.videojs.error().code === 4) {
        if (content.videojs.src().includes("m3u8")) {
          // HLS could not be streamed
          console.error("Video.js: HLS stream could not be opened.");

          if (getCurrentUser()?.isAdmin) {
            showError(t("memories", "Transcoding failed."));
          }

          content.videojs.src({
            src: content.data.src,
            type: "video/mp4",
          });
          this.updateRotation(content, 0);
        }
      }
    });

    // setTimeout(() => {
    //   content.videojs.play(); // iOS needs this
    // }, 200);

    let canPlay = false;
    content.videojs.on("canplay", () => {
      canPlay = true;
      this.updateRotation(content); // also gets the correct video elem as a side effect
      content.videojs.play();
      return
    });

    // Get correct orientation
    if (!content.data.photo.imageInfo) {
      const url = API.IMAGE_INFO(content.data.photo.fileid);
      axios.get<any>(url).then((response) => {
        content.data.photo.imageInfo = response.data;

        // Update only after video is ready
        // Otherwise the poster image is rotated
        if (canPlay) this.updateRotation(content);
      });
    } else {
      if (canPlay) this.updateRotation(content);
    }
  }

  destroyVideo(content: any) {
    if (isVideoContent(content) && content.videojs) {
      content.videojs.dispose();
      content.videojs = null;

      const elem: HTMLDivElement = content.element;
      while (elem.lastElementChild) {
        elem.removeChild(elem.lastElementChild);
      }
      content.videoElement = null;
    }
  }

  updateRotation(content: any, val?: number): boolean {
    if (!content.videojs) return;

    content.videoElement = content.videojs.el()?.querySelector("video");
    if (!content.videoElement) return;

    const photo: IPhoto = content.data.photo;
    const exif = photo.imageInfo?.exif;
    const rotation = val ?? Number(exif?.Rotation || 0);
    const shouldRotate = content.videojs?.src().includes("m3u8");

    if (rotation && shouldRotate) {
      let transform = `rotate(${rotation}deg)`;
      const hasRotation = rotation === 90 || rotation === 270;

      if (hasRotation) {
        content.videoElement.style.width = content.element.style.height;
        content.videoElement.style.height = content.element.style.width;

        transform = `translateY(-${content.element.style.width}) ${transform}`;
        content.videoElement.style.transformOrigin = "bottom left";
      }

      content.videoElement.style.transform = transform;

      return hasRotation;
    } else {
      content.videoElement.style.transform = "none";
      content.videoElement.style.width = "100%";
      content.videoElement.style.height = "100%";
    }

    return false;
  }

  onContentDestroy({ content }) {
    if (isVideoContent(content)) {
      if (content.videojs) {
        content.videojs.dispose();
        content.videojs = null;
      }
    }
  }

  onContentResize(e) {
    if (isVideoContent(e.content)) {
      e.preventDefault();

      const width = e.width;
      const height = e.height;
      const content = e.content;

      if (content.element) {
        content.element.style.width = width + "px";
        content.element.style.height = height + "px";
      }

      if (content.slide && content.slide.placeholder) {
        // override placeholder size, so it more accurately matches the video
        const placeholderElStyle = content.slide.placeholder.element.style;
        placeholderElStyle.transform = "none";
        placeholderElStyle.width = width + "px";
        placeholderElStyle.height = height + "px";
      }

      this.updateRotation(content);
    }
  }

  isKeepingPlaceholder(isZoomable, content) {
    if (isVideoContent(content)) {
      return false;
    }
    return isZoomable;
  }

  isContentZoomable(isZoomable, content) {
    if (isVideoContent(content)) {
      return false;
    }
    return isZoomable;
  }

  onContentActivate({ content }) {
    this.initVideo(content);
  }

  onContentDeactivate({ content }) {
    this.destroyVideo(content);
  }

  onContentAppend(e) {
    if (isVideoContent(e.content)) {
      e.preventDefault();
      e.content.isAttached = true;
      e.content.appendImage();
    }
  }

  onContentLoad(e) {
    const content = e.content; // todo: videocontent

    if (!isVideoContent(e.content)) {
      return;
    }

    // stop default content load
    e.preventDefault();

    if (content.element) {
      return;
    }

    if (config_noTranscode === "UNSET") {
      content.element = document.createElement("div");
      content.element.innerHTML =
        "Video not configured. Run occ memories:video-setup";
      content.element.style.color = "red";
      content.element.style.display = "flex";
      content.element.style.alignItems = "center";
      content.element.style.justifyContent = "center";
      content.onLoaded();
      return;
    }

    content.state = "loading";
    content.type = "video"; // TODO: move this to pswp core?

    content.element = document.createElement("div");
    content.element.style.position = "absolute";
    content.element.style.left = 0;
    content.element.style.top = 0;
    content.element.style.width = "100%";
    content.element.style.height = "100%";

    content.onLoaded();
  }

  useContentPlaceholder(usePlaceholder, content) {
    if (isVideoContent(content)) {
      return true;
    }
    return usePlaceholder;
  }
}

export default VideoContentSetup;
