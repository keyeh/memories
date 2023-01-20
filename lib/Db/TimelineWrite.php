<?php

declare(strict_types=1);

namespace OCA\Memories\Db;

use OCA\Memories\AppInfo\Application;
use OCA\Memories\Exif;
use OCP\DB\QueryBuilder\IQueryBuilder;
use OCP\Files\File;
use OCP\IDBConnection;
use OCP\IPreview;

class TimelineWrite
{
    protected IDBConnection $connection;
    protected IPreview $preview;
    protected LivePhoto $livePhoto;

    public function __construct(IDBConnection $connection)
    {
        $this->connection = $connection;
        $this->preview = \OC::$server->get(IPreview::class);
        $this->livePhoto = new LivePhoto($connection);
    }

    /**
     * Check if a file has a valid mimetype for processing.
     *
     * @return int 0 for invalid, 1 for image, 2 for video
     */
    public function getFileType(File $file): int
    {
        $mime = $file->getMimeType();
        if (\in_array($mime, Application::IMAGE_MIMES, true)) {
            // Make sure preview generator supports the mime type
            if (!$this->preview->isMimeSupported($mime)) {
                return 0;
            }

            return 1;
        }
        if (\in_array($mime, Application::VIDEO_MIMES, true)) {
            return 2;
        }

        return 0;
    }

    /**
     * Process a file to insert Exif data into the database.
     *
     * @return int 2 if processed, 1 if skipped, 0 if not valid
     */
    public function processFile(
        File &$file,
        bool $force = false
    ): int {
        // There is no easy way to UPSERT in a standard SQL way, so just
        // do multiple calls. The worst that can happen is more updates,
        // but that's not a big deal.
        // https://stackoverflow.com/questions/15252213/sql-standard-upsert-call

        // Check if we want to process this file
        $fileType = $this->getFileType($file);
        $isvideo = (2 === $fileType);
        if (!$fileType) {
            return 0;
        }

        // Get parameters
        $mtime = $file->getMtime();
        $fileId = $file->getId();

        // Check if need to update
        $query = $this->connection->getQueryBuilder();
        $query->select('fileid', 'mtime')
            ->from('memories')
            ->where($query->expr()->eq('fileid', $query->createNamedParameter($fileId, IQueryBuilder::PARAM_INT)))
        ;
        $cursor = $query->executeQuery();
        $prevRow = $cursor->fetch();
        $cursor->closeCursor();

        // Check in live-photo table in case this is a video part of a live photo
        if (!$prevRow) {
            $query = $this->connection->getQueryBuilder();
            $query->select('fileid', 'mtime')
                ->from('memories_livephoto')
                ->where($query->expr()->eq('fileid', $query->createNamedParameter($fileId, IQueryBuilder::PARAM_INT)))
            ;
            $cursor = $query->executeQuery();
            $prevRow = $cursor->fetch();
            $cursor->closeCursor();
        }

        if ($prevRow && !$force && (int) $prevRow['mtime'] === $mtime) {
            return 1;
        }

        // Get exif data
        $exif = [];

        try {
            $exif = Exif::getExifFromFile($file);
        } catch (\Exception $e) {
        }

        // Hand off if live photo video part
        if ($isvideo && $this->livePhoto->isVideoPart($exif)) {
            $this->livePhoto->processVideoPart($file, $exif);

            return 2;
        }

        // Get more parameters
        $dateTaken = Exif::getDateTaken($file, $exif);
        $dayId = floor($dateTaken / 86400);
        $dateTaken = gmdate('Y-m-d H:i:s', $dateTaken);
        [$w, $h] = Exif::getDimensions($exif);
        $liveid = $this->livePhoto->getLivePhotoId($exif);

        // Video parameters
        $videoDuration = 0;
        if ($isvideo) {
            $videoDuration = round((float) ($exif['Duration'] ?? $exif['TrackDuration'] ?? 0));
        }

        // Clean up EXIF to keep only useful metadata
        foreach ($exif as $key => &$value) {
            // Truncate any fields > 2048 chars
            if (\is_string($value) && \strlen($value) > 2048) {
                $exif[$key] = substr($value, 0, 2048);
            }

            // These are huge and not needed
            if (str_starts_with($key, 'Nikon') || str_starts_with($key, 'QuickTime')) {
                unset($exif[$key]);
            }
        }

        // Store JSON string
        $exifJson = json_encode($exif);

        // Store error if data > 64kb
        if (\is_string($exifJson)) {
            if (\strlen($exifJson) > 65535) {
                $exifJson = json_encode(['error' => 'Exif data too large']);
            }
        } else {
            $exifJson = json_encode(['error' => 'Exif data encoding error']);
        }

        if ($prevRow) {
            // Update existing row
            // No need to set objectid again
            $query->update('memories')
                ->set('dayid', $query->createNamedParameter($dayId, IQueryBuilder::PARAM_INT))
                ->set('datetaken', $query->createNamedParameter($dateTaken, IQueryBuilder::PARAM_STR))
                ->set('mtime', $query->createNamedParameter($mtime, IQueryBuilder::PARAM_INT))
                ->set('isvideo', $query->createNamedParameter($isvideo, IQueryBuilder::PARAM_INT))
                ->set('video_duration', $query->createNamedParameter($videoDuration, IQueryBuilder::PARAM_INT))
                ->set('w', $query->createNamedParameter($w, IQueryBuilder::PARAM_INT))
                ->set('h', $query->createNamedParameter($h, IQueryBuilder::PARAM_INT))
                ->set('exif', $query->createNamedParameter($exifJson, IQueryBuilder::PARAM_STR))
                ->set('liveid', $query->createNamedParameter($liveid, IQueryBuilder::PARAM_STR))
                ->where($query->expr()->eq('fileid', $query->createNamedParameter($fileId, IQueryBuilder::PARAM_INT)))
            ;
            $query->executeStatement();
        } else {
            // Try to create new row
            try {
                $query->insert('memories')
                    ->values([
                        'fileid' => $query->createNamedParameter($fileId, IQueryBuilder::PARAM_INT),
                        'objectid' => $query->createNamedParameter((string) $fileId, IQueryBuilder::PARAM_STR),
                        'dayid' => $query->createNamedParameter($dayId, IQueryBuilder::PARAM_INT),
                        'datetaken' => $query->createNamedParameter($dateTaken, IQueryBuilder::PARAM_STR),
                        'mtime' => $query->createNamedParameter($mtime, IQueryBuilder::PARAM_INT),
                        'isvideo' => $query->createNamedParameter($isvideo, IQueryBuilder::PARAM_INT),
                        'video_duration' => $query->createNamedParameter($videoDuration, IQueryBuilder::PARAM_INT),
                        'w' => $query->createNamedParameter($w, IQueryBuilder::PARAM_INT),
                        'h' => $query->createNamedParameter($h, IQueryBuilder::PARAM_INT),
                        'exif' => $query->createNamedParameter($exifJson, IQueryBuilder::PARAM_STR),
                        'liveid' => $query->createNamedParameter($liveid, IQueryBuilder::PARAM_STR),
                    ])
                ;
                $query->executeStatement();
            } catch (\Exception $ex) {
                error_log('Failed to create memories record: '.$ex->getMessage());
            }
        }

        return 2;
    }

    /**
     * Remove a file from the exif database.
     */
    public function deleteFile(File &$file)
    {
        $deleteFrom = function ($table) use (&$file) {
            $query = $this->connection->getQueryBuilder();
            $query->delete($table)
                ->where($query->expr()->eq('fileid', $query->createNamedParameter($file->getId(), IQueryBuilder::PARAM_INT)))
            ;
            $query->executeStatement();
        };
        $deleteFrom('memories');
        $deleteFrom('memories_livephoto');
    }

    /**
     * Clear the entire index. Does not need confirmation!
     *
     * @param File $file
     */
    public function clear()
    {
        $p = $this->connection->getDatabasePlatform();
        $t1 = $p->getTruncateTableSQL('`*PREFIX*memories`', false);
        $t2 = $p->getTruncateTableSQL('`*PREFIX*memories_livephoto`', false);
        $this->connection->executeStatement("{$t1}; {$t2}");
    }

    /**
     * Mark a file as not orphaned.
     */
    public function unorphan(File &$file)
    {
        $query = $this->connection->getQueryBuilder();
        $query->update('memories')
            ->set('orphan', $query->createNamedParameter(false, IQueryBuilder::PARAM_BOOL))
            ->where($query->expr()->eq('fileid', $query->createNamedParameter($file->getId(), IQueryBuilder::PARAM_INT)))
        ;
        $query->executeStatement();
    }

    /**
     * Mark all files in the table as orphaned.
     *
     * @return int Number of rows affected
     */
    public function orphanAll(): int
    {
        $query = $this->connection->getQueryBuilder();
        $query->update('memories')
            ->set('orphan', $query->createNamedParameter(true, IQueryBuilder::PARAM_BOOL))
        ;

        return $query->executeStatement();
    }

    /**
     * Remove all entries that are orphans.
     *
     * @return int Number of rows affected
     */
    public function removeOrphans(): int
    {
        $query = $this->connection->getQueryBuilder();
        $query->delete('memories')
            ->where($query->expr()->eq('orphan', $query->createNamedParameter(true, IQueryBuilder::PARAM_BOOL)))
        ;

        return $query->executeStatement();
    }
}
