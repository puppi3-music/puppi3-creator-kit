// The kit's storage for Ghost's images, media and files in an S3 bucket (k8s/components/s3-storage/). It is Ghost's
// own S3Storage (core/server/adapters/storage/S3Storage.js: saving, resized images, multipart uploads, deletes), with
// one change: serve() streams a file from the bucket instead of redirecting to a separate CDN address. So files stay
// at https://<site>/content/images/... as with Ghost's local storage (Cloudflare caches them), the bucket stays
// private (Ghost reaches it with its own credentials: keys, or the cloud's workload identity), and posts keep
// __GHOST_URL__/content/... links, the same on the NAS and in a bucket.
// Mounted beside Ghost's own adapters (ConfigMap ghost-s3-adapter), so it loads Ghost's S3Storage and AWS SDK.
'use strict';
const path = require('path');
const S3Storage = require('./S3Storage').default;
const { GetObjectCommand } = require('@aws-sdk/client-s3');
const errors = require('@tryghost/errors');

// what a response passes on from the bucket's answer
const HEADERS = {
    ContentLength: 'content-length',
    ContentRange: 'content-range',
    AcceptRanges: 'accept-ranges',
    ETag: 'etag',
    LastModified: 'last-modified',
};

class KitS3Storage extends S3Storage {
    serve() {
        return async (req, res, next) => {
            let key;
            try {
                const relativePath = decodeURIComponent(req.path).replace(/^\/+/, '');
                if (!relativePath) {
                    return next();
                }
                key = this.buildKey(relativePath);
            } catch {
                return next(new errors.NotFoundError({ message: 'File not found', code: 'STATIC_FILE_NOT_FOUND' }));
            }
            try {
                const out = await this.client.send(new GetObjectCommand({
                    Bucket: this.bucket,
                    Key: key,
                    Range: req.headers.range,          // audio and video players ask for parts
                    IfNoneMatch: req.headers['if-none-match'],
                }));
                res.status(out.ContentRange ? 206 : 200);
                for (const [field, header] of Object.entries(HEADERS)) {
                    if (out[field] !== undefined) {
                        res.set(header, field === 'LastModified' ? out[field].toUTCString() : String(out[field]));
                    }
                }
                // Resized images are saved with no type (Ghost's saveRaw); a format change (/format/webp/) has
                // set its own already
                if (out.ContentType && !/octet-stream/.test(out.ContentType)) {
                    res.type(out.ContentType);
                } else if (!res.get('content-type')) {
                    res.type(path.extname(key) || 'application/octet-stream');
                }
                // as Ghost's local storage: a year (a changed file gets a new name)
                res.set('cache-control', 'public, max-age=31536000');
                if (req.method === 'HEAD') {
                    out.Body.destroy?.();
                    return res.end();
                }
                out.Body.on('error', next);
                out.Body.pipe(res);
            } catch (err) {
                const status = err?.$metadata?.httpStatusCode;
                if (status === 304) {
                    return res.status(304).end();
                }
                if (status === 416) {
                    return res.status(416).end();
                }
                if (this.isNotFound(err) || status === 404) {
                    return next(new errors.NotFoundError({ message: 'File not found', code: 'STATIC_FILE_NOT_FOUND' }));
                }
                next(err);
            }
        };
    }
}

module.exports = KitS3Storage;
