import { Cache } from './Cache.js';
import { Loader } from './Loader.js';

const loading = {};

function base64ToArrayBuffer( base64 ) {

	const binary = atob( base64 );
	const len = binary.length;
	const bytes = new Uint8Array( len );
	for ( let i = 0; i < len; i ++ ) {

		bytes[ i ] = binary.charCodeAt( i );

	}

	return bytes.buffer;

}

/**
 * @param {string} url
 * @param {string} responseType
 * @param {string} mimeType From {@link FileLoader#mimeType}.
 * @return {any}
 */
function parseDataUri( url, responseType, mimeType ) {

	const comma = url.indexOf( ',' );
	if ( comma < 0 || ! url.startsWith( 'data:' ) ) {

		throw new Error( 'FileLoader: Malformed data URI.' );

	}

	const meta = url.slice( 5, comma );
	const dataPart = url.slice( comma + 1 );
	const isBase64 = /;base64/i.test( meta );
	const mediatype = ( meta.replace( /;base64/i, '' ).replace( /^;+/, '' ).trim() ) || 'text/plain;charset=US-ASCII';

	let rawBytes = null;
	let rawText = null;

	if ( isBase64 ) {

		const b64 = dataPart.replace( /\s/g, '' );
		rawBytes = base64ToArrayBuffer( b64 );

	} else {

		rawText = decodeURIComponent( dataPart );

	}

	switch ( responseType ) {

		case 'arraybuffer':

			if ( isBase64 ) return rawBytes;
			return new TextEncoder().encode( rawText ).buffer;

		case 'blob': {

			const blobType = mediatype.split( ';' )[ 0 ] || '';
			if ( isBase64 ) return new Blob( [ rawBytes ], { type: blobType } );
			return new Blob( [ rawText ], { type: blobType } );

		}

		case 'document': {

			const text = isBase64 ? new TextDecoder().decode( new Uint8Array( rawBytes ) ) : rawText;
			const mimeForParser = mimeType !== '' ? mimeType : mediatype;
			const parser = new DOMParser();
			return parser.parseFromString( text, mimeForParser );

		}

		case 'json': {

			const text = isBase64 ? new TextDecoder().decode( new Uint8Array( rawBytes ) ) : rawText;
			return JSON.parse( text );

		}

		default:

			if ( mimeType === '' ) {

				return isBase64 ? new TextDecoder().decode( new Uint8Array( rawBytes ) ) : rawText;

			} else {

				const re = /charset="?([^;"\s]*)"?/i;
				const exec = re.exec( mimeType );
				const label = exec && exec[ 1 ] ? exec[ 1 ].toLowerCase() : undefined;
				const decoder = new TextDecoder( label );
				const ab = isBase64 ? rawBytes : new TextEncoder().encode( rawText ).buffer;
				return decoder.decode( new Uint8Array( ab ) );

			}

	}

}

/**
 * A low level class for loading resources without network access. Only
 * `data:` URIs and values pre-populated in {@link Cache} are supported.
 * This is suitable for restricted hosts (for example Power BI custom visuals).
 *
 * This loader supports caching. If you want to use it, add `THREE.Cache.enabled = true;`
 * once to your application.
 *
 * ```js
 * const loader = new THREE.FileLoader();
 * const data = await loader.loadAsync( 'data:text/plain,hello' );
 * ```
 *
 * @augments Loader
 */
class FileLoader extends Loader {

	/**
	 * Constructs a new file loader.
	 *
	 * @param {LoadingManager} [manager] - The loading manager.
	 */
	constructor( manager ) {

		super( manager );

		/**
		 * The expected mime type. Valid values can be found
		 * [here](https://developer.mozilla.org/en-US/docs/Web/API/DOMParser/parseFromString#mimetype)
		 *
		 * @type {string}
		 */
		this.mimeType = '';

		/**
		 * The expected response type.
		 *
		 * @type {('arraybuffer'|'blob'|'document'|'json'|'')}
		 * @default ''
		 */
		this.responseType = '';

		/**
		 * Used for aborting in-flight loads.
		 *
		 * @private
		 * @type {AbortController}
		 */
		this._abortController = new AbortController();

	}

	/**
	 * Starts loading from the given URL and pass the loaded response to the `onLoad()` callback.
	 *
	 * @param {string} url - A `data:` URI, or a key that has been stored in {@link Cache} (after {@link LoadingManager#resolveURL}).
	 * @param {function(any)} onLoad - Executed when the loading process has been finished.
	 * @param {onProgressCallback} [onProgress] - Executed while the loading is in progress.
	 * @param {onErrorCallback} [onError] - Executed when errors occur.
	 */
	load( url, onLoad, onProgress, onError ) {

		if ( url === undefined ) url = '';

		if ( this.path !== undefined ) url = this.path + url;

		url = this.manager.resolveURL( url );

		const cached = Cache.get( `file:${url}` );

		if ( cached !== undefined ) {

			this.manager.itemStart( url );

			setTimeout( () => {

				if ( onLoad ) onLoad( cached );

				this.manager.itemEnd( url );

			}, 0 );

			return;

		}

		if ( loading[ url ] !== undefined ) {

			loading[ url ].push( {

				onLoad: onLoad,
				onProgress: onProgress,
				onError: onError

			} );

			return;

		}

		loading[ url ] = [];

		loading[ url ].push( {
			onLoad: onLoad,
			onProgress: onProgress,
			onError: onError,
		} );

		const mimeType = this.mimeType;
		const responseType = this.responseType;

		const signal = this._abortController.signal;
		const managerSignal = this.manager.abortController.signal;

		const fail = ( err ) => {

			const callbacks = loading[ url ];

			if ( callbacks === undefined ) {

				this.manager.itemError( url );
				throw err;

			}

			delete loading[ url ];

			for ( let i = 0, il = callbacks.length; i < il; i ++ ) {

				const callback = callbacks[ i ];
				if ( callback.onError ) callback.onError( err );

			}

			this.manager.itemError( url );

		};

		Promise.resolve()
			.then( () => {

				if ( signal.aborted || managerSignal.aborted ) {

					throw new DOMException( 'The operation was aborted.', 'AbortError' );

				}

				if ( ! url.startsWith( 'data:' ) ) {

					throw new Error(
						'FileLoader: Network loading is disabled. Use data: URIs or populate THREE.Cache before loading.'
					);

				}

				return parseDataUri( url, responseType, mimeType );

			} )
			.then( ( data ) => {

				if ( signal.aborted || managerSignal.aborted ) {

					throw new DOMException( 'The operation was aborted.', 'AbortError' );

				}

				const callbacks = loading[ url ];
				let len = 0;
				if ( typeof data === 'string' ) len = data.length;
				else if ( data instanceof ArrayBuffer ) len = data.byteLength;
				else if ( typeof Blob !== 'undefined' && data instanceof Blob ) len = data.size;
				else if ( data && typeof data.byteLength === 'number' ) len = data.byteLength;
				const progressEvent = new ProgressEvent( 'progress', {
					lengthComputable: len !== 0,
					loaded: len,
					total: len,
				} );
				for ( let i = 0, il = callbacks.length; i < il; i ++ ) {

					const callback = callbacks[ i ];
					if ( callback.onProgress ) callback.onProgress( progressEvent );

				}

				Cache.add( `file:${url}`, data );

				delete loading[ url ];

				for ( let i = 0, il = callbacks.length; i < il; i ++ ) {

					const callback = callbacks[ i ];
					if ( callback.onLoad ) callback.onLoad( data );

				}

			} )
			.catch( ( err ) => {

				fail( err );

			} )
			.finally( () => {

				this.manager.itemEnd( url );

			} );

		this.manager.itemStart( url );

	}

	/**
	 * Sets the expected response type.
	 *
	 * @param {('arraybuffer'|'blob'|'document'|'json'|'')} value - The response type.
	 * @return {FileLoader} A reference to this file loader.
	 */
	setResponseType( value ) {

		this.responseType = value;
		return this;

	}

	/**
	 * Sets the expected mime type of the loaded file.
	 *
	 * @param {string} value - The mime type.
	 * @return {FileLoader} A reference to this file loader.
	 */
	setMimeType( value ) {

		this.mimeType = value;
		return this;

	}

	/**
	 * Aborts ongoing loads.
	 *
	 * @return {FileLoader} A reference to this instance.
	 */
	abort() {

		this._abortController.abort();
		this._abortController = new AbortController();

		return this;

	}

}


export { FileLoader };
