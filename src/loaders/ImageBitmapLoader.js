import { Cache } from './Cache.js';
import { Loader } from './Loader.js';
import { warn } from '../utils.js';

const _errorMap = new WeakMap();

/**
 * @param {string} url
 * @return {Blob}
 */
function dataUriToBlob( url ) {

	const comma = url.indexOf( ',' );
	if ( comma < 0 || ! url.startsWith( 'data:' ) ) {

		throw new Error( 'ImageBitmapLoader: Malformed data URI.' );

	}

	const meta = url.slice( 5, comma );
	const dataPart = url.slice( comma + 1 );
	const isBase64 = /;base64/i.test( meta );
	const mediatype = ( meta.replace( /;base64/i, '' ).replace( /^;+/, '' ).trim() ) || 'text/plain;charset=US-ASCII';
	const blobType = mediatype.split( ';' )[ 0 ] || 'application/octet-stream';

	if ( isBase64 ) {

		const b64 = dataPart.replace( /\s/g, '' );
		const binary = atob( b64 );
		const len = binary.length;
		const bytes = new Uint8Array( len );
		for ( let i = 0; i < len; i ++ ) {

			bytes[ i ] = binary.charCodeAt( i );

		}

		return new Blob( [ bytes ], { type: blobType } );

	}

	return new Blob( [ decodeURIComponent( dataPart ) ], { type: blobType } );

}

/**
 * A loader for loading images as an [ImageBitmap](https://developer.mozilla.org/en-US/docs/Web/API/ImageBitmap).
 * An `ImageBitmap` provides an asynchronous and resource efficient pathway to prepare
 * textures for rendering.
 *
 * This build does not use network requests: only `data:` URIs and {@link Cache} are supported
 * (for example for Power BI–style restricted hosts).
 *
 * Note that {@link Texture#flipY} and {@link Texture#premultiplyAlpha} are ignored with image bitmaps.
 * These options need to be configured via {@link ImageBitmapLoader#setOptions} prior to loading,
 * unlike regular images which can be configured on the Texture to set these options on GPU upload instead.
 *
 * To match the default behaviour of {@link Texture}, the following options are needed:
 *
 * ```js
 * { imageOrientation: 'flipY', premultiplyAlpha: 'none' }
 * ```
 *
 * Also note that unlike {@link FileLoader}, this loader will only avoid multiple concurrent requests to the same URL if {@link Cache} is enabled.
 *
 * ```js
 * const loader = new THREE.ImageBitmapLoader();
 * loader.setOptions( { imageOrientation: 'flipY' } ); // set options if needed
 * const imageBitmap = await loader.loadAsync( 'data:image/png;base64,...' );
 *
 * const texture = new THREE.Texture( imageBitmap );
 * texture.needsUpdate = true;
 * ```
 *
 * @augments Loader
 */
class ImageBitmapLoader extends Loader {

	/**
	 * Constructs a new image bitmap loader.
	 *
	 * @param {LoadingManager} [manager] - The loading manager.
	 */
	constructor( manager ) {

		super( manager );

		/**
		 * This flag can be used for type testing.
		 *
		 * @type {boolean}
		 * @readonly
		 * @default true
		 */
		this.isImageBitmapLoader = true;

		if ( typeof createImageBitmap === 'undefined' ) {

			warn( 'ImageBitmapLoader: createImageBitmap() not supported.' );

		}

		/**
		 * Represents the loader options.
		 *
		 * @type {Object}
		 * @default {premultiplyAlpha:'none'}
		 */
		this.options = { premultiplyAlpha: 'none' };

		/**
		 * Used for aborting in-flight loads.
		 *
		 * @private
		 * @type {AbortController}
		 */
		this._abortController = new AbortController();

	}

	/**
	 * Sets the given loader options. The structure of the object must match the `options` parameter of
	 * [createImageBitmap](https://developer.mozilla.org/en-US/docs/Web/API/Window/createImageBitmap).
	 *
	 * Note: When caching is enabled, the cache key is based on the URL only. Loading the same URL with
	 * different options will return the cached result of the first request.
	 *
	 * @param {Object} options - The loader options to set.
	 * @return {ImageBitmapLoader} A reference to this image bitmap loader.
	 */
	setOptions( options ) {

		this.options = options;

		return this;

	}

	/**
	 * Starts loading from the given URL and pass the loaded image bitmap to the `onLoad()` callback.
	 *
	 * @param {string} url - A `data:` image URI, or a key that has been stored in {@link Cache} (after {@link LoadingManager#resolveURL}).
	 * @param {function(ImageBitmap)} onLoad - Executed when the loading process has been finished.
	 * @param {onProgressCallback} onProgress - Unsupported in this loader.
	 * @param {onErrorCallback} onError - Executed when errors occur.
	 */
	load( url, onLoad, onProgress, onError ) {

		if ( url === undefined ) url = '';

		if ( this.path !== undefined ) url = this.path + url;

		url = this.manager.resolveURL( url );

		const scope = this;

		const cached = Cache.get( `image-bitmap:${url}` );

		if ( cached !== undefined ) {

			scope.manager.itemStart( url );

			// If cached is a promise, wait for it to resolve
			if ( cached.then ) {

				cached.then( imageBitmap => {

					// check if there is an error for the cached promise

					if ( _errorMap.has( cached ) === true ) {

						if ( onError ) onError( _errorMap.get( cached ) );

						scope.manager.itemError( url );
						scope.manager.itemEnd( url );

					} else {

						if ( onLoad ) onLoad( imageBitmap );

						scope.manager.itemEnd( url );

					}

				} );

				return;

			}

			// If cached is not a promise (i.e., it's already an imageBitmap)
			setTimeout( function () {

				if ( onLoad ) onLoad( cached );

				scope.manager.itemEnd( url );

			}, 0 );

			return;

		}

		const signal = this._abortController.signal;
		const managerSignal = this.manager.abortController.signal;

		const promise = Promise.resolve()
			.then( function () {

				if ( signal.aborted || managerSignal.aborted ) {

					throw new DOMException( 'The operation was aborted.', 'AbortError' );

				}

				if ( ! url.startsWith( 'data:' ) ) {

					throw new Error(
						'ImageBitmapLoader: Network loading is disabled. Use data: URIs or populate THREE.Cache before loading.'
					);

				}

				return dataUriToBlob( url );

			} )
			.then( function ( blob ) {

				if ( signal.aborted || managerSignal.aborted ) {

					throw new DOMException( 'The operation was aborted.', 'AbortError' );

				}

				return createImageBitmap( blob, Object.assign( scope.options, { colorSpaceConversion: 'none' } ) );

			} )
			.then( function ( imageBitmap ) {

				Cache.add( `image-bitmap:${url}`, imageBitmap );

				if ( onLoad ) onLoad( imageBitmap );

				scope.manager.itemEnd( url );

			} )
			.catch( function ( e ) {

				if ( onError ) onError( e );

				_errorMap.set( promise, e );

				Cache.remove( `image-bitmap:${url}` );

				scope.manager.itemError( url );
				scope.manager.itemEnd( url );

			} );

		Cache.add( `image-bitmap:${url}`, promise );
		scope.manager.itemStart( url );

	}

	/**
	 * Aborts ongoing loads.
	 *
	 * @return {ImageBitmapLoader} A reference to this instance.
	 */
	abort() {

		this._abortController.abort();
		this._abortController = new AbortController();

		return this;

	}

}

export { ImageBitmapLoader };
