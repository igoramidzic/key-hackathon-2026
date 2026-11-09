import type { RepoOverlay } from '../types';

/** keybank/GLD00/gl-posting-service: real-time general ledger posting. */
export const GLD_REPO = 'keybank/GLD00/gl-posting-service';

export const GLD_PATHS = {
  businessDateValidator: 'src/main/java/com/keybank/gld/posting/BusinessDateValidator.java',
} as const;

const BUSINESS_DATE_VALIDATOR = `package com.keybank.gld.posting;

import java.time.LocalDate;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * Postings must target the ledger's open business date. Back-dated postings need a manual
 * adjustment journal; future-dated postings are rejected and re-submitted by the source system
 * after end-of-day close rolls the date.
 */
@Component
public class BusinessDateValidator {

  private static final Logger log = LoggerFactory.getLogger(BusinessDateValidator.class);

  private final JdbcTemplate jdbc;

  public BusinessDateValidator(JdbcTemplate jdbc) {
    this.jdbc = jdbc;
  }

  public record PostingHeader(
      String ledger, String journalId, String sourceSystem, LocalDate businessDate) {}

  public void validate(PostingHeader posting) {
    LocalDate open = openBusinessDate(posting.ledger());
    if (posting.businessDate().isAfter(open)) {
      log.warn(
          "Posting rejected: future business date {} (open business date {}) source={} journal={}",
          posting.businessDate(), open, posting.sourceSystem(), posting.journalId());
      throw new PostingRejectedException(
          "FUTURE_BUSINESS_DATE",
          "Business date " + posting.businessDate() + " is after open business date " + open);
    }
    if (posting.businessDate().isBefore(open)) {
      log.warn(
          "Posting rejected: closed business date {} (open business date {}) source={} journal={}",
          posting.businessDate(), open, posting.sourceSystem(), posting.journalId());
      throw new PostingRejectedException(
          "CLOSED_BUSINESS_DATE",
          "Business date " + posting.businessDate() + " is already closed (open " + open + ")");
    }
  }

  private LocalDate openBusinessDate(String ledger) {
    return jdbc.queryForObject(
        "select open_business_date from gl_control where ledger_code = ?", LocalDate.class, ledger);
  }

  /** Mapped to HTTP 422 with { "code": ..., "message": ... }. */
  public static class PostingRejectedException extends RuntimeException {
    private final String code;

    public PostingRejectedException(String code, String message) {
      super(message);
      this.code = code;
    }

    public String getCode() {
      return code;
    }
  }
}
`;

export const gldOverlay: RepoOverlay = {
  complete: false,
  files: {
    [GLD_PATHS.businessDateValidator]: BUSINESS_DATE_VALIDATOR,
  },
};
