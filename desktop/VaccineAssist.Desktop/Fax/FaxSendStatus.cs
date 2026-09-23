namespace VaccineAssist.Desktop.Fax;

/// <summary>Vendor-neutral fax delivery status — every IFaxClient
/// implementation maps its own vendor's status text onto this set.</summary>
public enum FaxSendStatus
{
    Queued,
    InProcess,
    Sent,
    Failed,
}
