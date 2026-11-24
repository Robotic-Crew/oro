/**
 * Copyright 2026 Robotic Crew
 *
 *    Licensed under the Apache License, Version 2.0 (the "License");
 *    you may not use this file except in compliance with the License.
 *    You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *    Unless required by applicable law or agreed to in writing, software
 *    distributed under the License is distributed on an "AS IS" BASIS,
 *    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *    See the License for the specific language governing permissions and
 *    limitations under the License.
 */

/**
 * Perception images, fetched on demand with the perceptionImage method (the
 * publication leaves them out) and kept as object URLs in a small LRU cache per
 * widget. URLs are revoked when evicted, when the robot changes and on unmount.
 */
import { useEffect, useRef, useState } from 'react';
import { ENDPOINTS, imageMime } from '../shared';
import { getPluginContext } from './pluginContext';

const MAX_CONCURRENT = 3;

const toObjectUrl = ({ mime, data }) => {
  const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
  return URL.createObjectURL(new Blob([bytes], { type: imageMime(mime) }));
};

const createImageCache = ({ robotId, maxSize, onChange }) => {
  // resultId -> object URL, or null while loading. Map order = least recently used first
  const entries = new Map();
  const queue = [];
  let active = 0;
  let disposed = false;

  const snapshot = () => Object.fromEntries([...entries].filter(([, url]) => url));

  const evict = (keep) => {
    [...entries.keys()].some((id) => {
      if (entries.size <= maxSize) return true;
      if (!keep.has(id)) {
        const url = entries.get(id);
        if (url) URL.revokeObjectURL(url);
        entries.delete(id);
      }
      return false;
    });
  };

  const next = () => {
    while (!disposed && active < MAX_CONCURRENT && queue.length) {
      const id = queue.shift();
      if (entries.has(id) && entries.get(id) === null) {
        active += 1;
        getPluginContext().call(ENDPOINTS.PERCEPTION_IMAGE, { robotId, resultId: id })
          .then((image) => {
            // Evicted or disposed meanwhile: nothing to keep
            if (disposed || !entries.has(id)) return;
            if (image?.data) {
              entries.set(id, toObjectUrl(image));
              onChange(snapshot());
            }
          })
          .catch(() => {
            // Retried when it is wanted again
            if (entries.get(id) === null) entries.delete(id);
          })
          .finally(() => {
            active -= 1;
            next();
          });
      }
    }
  };

  return {
    /** Fetches the images of `ids` (in priority order) not cached yet. */
    want(ids) {
      ids.forEach((id) => {
        if (entries.has(id)) {
          // Most recently used last
          const url = entries.get(id);
          entries.delete(id);
          entries.set(id, url);
        } else {
          entries.set(id, null);
          queue.push(id);
        }
      });
      evict(new Set(ids));
      onChange(snapshot());
      next();
    },
    dispose() {
      disposed = true;
      queue.length = 0;
      entries.forEach(url => url && URL.revokeObjectURL(url));
      entries.clear();
    },
  };
};

/**
 * Object URLs of the images of the perception results `ids` (of results that
 * have one), as { [resultId]: url }. `ids` in priority order.
 */
const usePerceptionImages = (robotId, ids, maxSize) => {
  const [urls, setUrls] = useState({});
  const cache = useRef(null);
  useEffect(() => {
    cache.current = createImageCache({ robotId, maxSize, onChange: setUrls });
    return () => {
      cache.current.dispose();
      cache.current = null;
      setUrls({});
    };
  }, [robotId, maxSize]);
  const key = ids.join(',');
  useEffect(() => {
    cache.current?.want(ids);
  }, [robotId, maxSize, key]); // eslint-disable-line react-hooks/exhaustive-deps
  return urls;
};

export default usePerceptionImages;
