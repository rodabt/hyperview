// @flow

/**
 * Copyright (c) Garuda Labs, Inc.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {
    Fetch,
    HttpCache,
    HttpCacheValue,
    RequestOptions,
    Response as ResponseType,
} from 'hyperview/src/services/cache/types';
import { Cache } from 'react-native-cache';
import AsyncStorage from '@react-native-async-storage/async-storage';
import CachePolicy from 'http-cache-semantics';
import * as Events from 'hyperview/src/services/events';

const cachePolicyOptions = {
  shared: false,
};

const handleCacheMiss = async (
  url: string,
  options: RequestOptions,
  cache: HttpCache,
  baseFetch: Fetch,
): Promise<Response> => {
  console.log(`cache miss for ${url}`);
  return baseFetch(url, options).then(async response => {
    const cachePolicy = new CachePolicy(options, response, cachePolicyOptions);
    if (!cachePolicy.storable()) {
      console.log(`response for ${url} is not cacheable`);
      return response;
    }
    console.log('BASE FETCH RESPONSE HEADERS', response.headers, options)

    const clonedResponse = response.clone();
    const text = await clonedResponse.clone().text();

    response.blob().then(async blob => {
      const cacheValue: HttpCacheValue = {
        text: text,
        headers: clonedResponse.headers,
        size: blob.size,
        policy: cachePolicy.toObject(),
      };
      const expiry = cachePolicy.timeToLive();
      console.log(`caching ${url} for ${expiry}ms`);
      await cache.set(url, cacheValue, expiry);
    });

    return clonedResponse;
  });
};

const revalidateCacheHit = (
  url: string,
  cacheValue: HttpCacheValue,
  options: RequestOptions,
  cache: HttpCache,
  baseFetch: Fetch,
): Promise<Response> => {
  const { text } = cacheValue;
  const policy = CachePolicy.fromObject(cacheValue.policy);

  const revalidationHeaders = policy.revalidationHeaders(options);
  const revalidationOptions = { ...options, headers: revalidationHeaders };
  const headers = policy.responseHeaders();

  setTimeout(() => Events.dispatchCustomEvent("response-stale-revalidating", url), 10);


  baseFetch(url, revalidationOptions).then(revalidationResponse => {
    const revalidation = policy.revalidatedPolicy(
      options,
      revalidationResponse,
    );
    const revalidatedPolicy = revalidation.policy;
    const modified: boolean = revalidation.modified;

    console.log(modified ? 'modified' : 'not modified');
    const newResponse = modified ? revalidationResponse : new Response(text, { headers: headers });


    setTimeout(() => newResponse.blob().then(async blob => {
      const newCacheValue: HttpCacheValue = {
        text: text,
        size: blob.size,
        headers: newResponse.headers,
        policy: revalidatedPolicy.toObject(),
      };
      const expiry = revalidatedPolicy.timeToLive();
      console.log(`caching ${url} for ${expiry}ms`);
      await cache.set(url, newCacheValue, expiry);
      Events.dispatchCustomEvent("response-revalidated", url);
    }), 2000);

    return newResponse.clone();
  });

  // console.log('STALEEEEE')
  return new Response(text, { headers: headers });
};

const handleCacheHit = (
  url: string,
  cacheValue: HttpCacheValue,
  options: RequestOptions,
  cache: HttpCache,
  baseFetch: Fetch,
): Promise<Response> => {
  const { text } = cacheValue;
  const policy = CachePolicy.fromObject(cacheValue.policy);

  console.log(`cache hit for ${url}`);
  if (policy.satisfiesWithoutRevalidation(options)) {
    console.log(`cached response can be used without revalidation`);
    const headers = policy.responseHeaders();
    const response = new Response(text, { headers: headers });
    return Promise.resolve(response);
  }

  console.log(`cached response needs to be revalidated`);
  return revalidateCacheHit(url, cacheValue, options, cache, baseFetch);
};

const cachedFetch = async (
  url: string,
  options: RequestOptions,
  cache: HttpCache,
  baseFetch: Fetch,
): Promise<ResponseType> => {
  const cacheValue: HttpCacheValue = await cache.get(url);
  // await cache.clearAll();

  // HTTP method needs to be uppercase for
  let optionsNew;
  if (!url.includes('without_caching.xml')) {
    optionsNew = { ...options, method: options.method?.toUpperCase() };
  } else {
    optionsNew = { ...options, method: options.method?.toUpperCase(), headers: { ...options.headers, 'cache-control': 'no-cache, no-store' } };
  }
  console.log('optionsNew', optionsNew)
  console.log('CACHE', cacheValue)
  if (cacheValue !== undefined) {
    return handleCacheHit(url, cacheValue, optionsNew, cache, baseFetch);
  }
  return handleCacheMiss(url, optionsNew, cache, baseFetch);
}

// **************************** //

/**
 * Creates an HTTP cache to use with fetch(). The cache will be
 */
export const createCache = (): HttpCache => {
  return new Cache({
    namespace: "hyperview",
    policy: {
      maxEntries: 50000, // if unspecified, it can have unlimited entries
      stdTTL: 0 // the standard ttl as number in seconds, default: 0 (unlimited)
    },
    backend: AsyncStorage,
  });
}
/**
 * Returns an implementation of fetch() that wraps the given implementation in an HTTP cache.
 */
export const wrapFetch = (cache: HttpCache, baseFetch: Fetch): Fetch => (
  url: string,
  options: RequestOptions,
): Promise<Response> => cachedFetch(url, options, cache, baseFetch);

export const clearCache = async (cache: any) => {
  await cache.clearCache();
}