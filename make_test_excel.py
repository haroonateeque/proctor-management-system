"""Generate a test Excel file with random student data for the
Proctor Register upload wizard (upload.html).

Headers intentionally use common ALIAS names (Roll No, Mobile Number,
Remarks, ...) to exercise excel.js auto column-detection.
DOB and phone numbers are written as TEXT so Excel doesn't mangle
leading zeros or turn dates into serial numbers.
"""
import random
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment

random.seed(42)  # reproducible data

first_names = ["Ayesha", "Bilal", "Hamza", "Zainab", "Fatima", "Usman", "Ali",
               "Maryam", "Hassan", "Hira", "Ahmed", "Sana", "Umair", "Noor",
               "Ibrahim", "Areeba", "Talha", "Kiran", "Danish", "Rimsha",
               "Saad", "Laiba", "Faisal", "Mahnoor", "Owais", "Amna", "Rehan",
               "Iqra", "Junaid", "Eman"]
last_names = ["Khan", "Ahmed", "Malik", "Butt", "Sheikh", "Qureshi", "Baig",
              "Raza", "Hussain", "Iqbal", "Javed", "Aslam", "Farooq", "Siddiqui",
              "Chaudhry", "Awan", "Gondal", "Mirza", "Nawaz", "Zafar"]

departments = ["Computer Science", "Electrical Engineering", "Business Administration",
               "Civil Engineering", "Software Engineering", "Mechanical Engineering"]
dept_short = {"Computer Science": "CS", "Electrical Engineering": "EE",
              "Business Administration": "BBA", "Civil Engineering": "CE",
              "Software Engineering": "SE", "Mechanical Engineering": "ME"}
sections = ["A", "B", "C"]
semesters = ["1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th"]
blood_groups = ["A+", "A-", "B+", "B-", "O+", "O-", "AB+", "AB-"]
hostel_status = ["Hostel", "Day Scholar"]
cities = ["Lahore", "Karachi", "Islamabad", "Multan", "Faisalabad", "Peshawar",
          "Quetta", "Rawalpindi", "Sialkot", "Gujranwala"]
areas = ["Model Town", "Gulberg", "DHA Phase 5", "Johar Town", "Satellite Town",
         "North Nazimabad", "Bahria Town", "Cantt", "Iqbal Town", "Wapda Town"]
remarks_pool = ["", "", "", "Sports team member", "Scholarship student",
                "Class representative", "Dean's list 2025", "Transferred from other campus"]

N = 25
used_ids = set()
rows = []
for _ in range(N):
    dept = random.choice(departments)
    year = random.choice([22, 23, 24])
    while True:
        serial = random.randint(1, 99)
        roll = f"{year}-{dept_short[dept]}-{serial:02d}"
        if roll not in used_ids:
            used_ids.add(roll)
            break
    name = f"{random.choice(first_names)} {random.choice(last_names)}"
    phone = "03" + "".join(random.choices("0123456789", k=9))
    guardian = f"{random.choice(['Mr. ' + random.choice(first_names), random.choice(first_names)])} {random.choice(last_names)}"
    guardian_phone = "03" + "".join(random.choices("0123456789", k=9))
    dob = f"{random.randint(1, 28):02d}-{random.choice(['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'])}-{random.randint(2001, 2005)}"
    cnic = f"{random.randint(31000, 42999)}-{random.randint(1000000, 9999999)}-{random.randint(1, 9)}"
    rows.append([
        name, roll, dept_short[dept], random.choice(sections), dept,
        random.choice(semesters), phone,
        f"{name.split()[0].lower()}.{roll.replace('-', '').lower()}@university.edu.pk",
        guardian, guardian_phone, random.choice(blood_groups),
        random.choice(hostel_status), dob, cnic,
        f"House {random.randint(1, 250)}, {random.choice(areas)}, {random.choice(cities)}",
        random.choice(remarks_pool),
    ])

headers = ["Full Name", "Roll No", "Class", "Section", "Department", "Semester",
           "Mobile Number", "Email", "Father Name", "Guardian Phone",
           "Blood Group", "Hostel Status", "Date of Birth", "CNIC",
           "Home Address", "Remarks"]

wb = Workbook()
ws = wb.active
ws.title = "Students"

header_fill = PatternFill("solid", fgColor="1F4E78")
header_font = Font(bold=True, color="FFFFFF")
for c, h in enumerate(headers, 1):
    cell = ws.cell(row=1, column=c, value=h)
    cell.fill = header_fill
    cell.font = header_font
    cell.alignment = Alignment(horizontal="center")

for r, row in enumerate(rows, 2):
    for c, v in enumerate(row, 1):
        cell = ws.cell(row=r, column=c, value=v)
        # force text format for phone/DOB/CNIC columns to preserve leading zeros
        if c in (7, 13, 14):
            cell.number_format = "@"

widths = [22, 12, 8, 9, 26, 10, 14, 34, 22, 15, 12, 14, 14, 18, 34, 24]
for i, w in enumerate(widths, 1):
    ws.column_dimensions[chr(64 + i)].width = w
ws.freeze_panes = "A2"

out = r"C:\Users\haroo\Desktop\test_students.xlsx"
wb.save(out)
print(f"Saved {out} with {len(rows)} students")
print("Sample row:", rows[0][:3], "...")
