const photo = id => `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=1200&q=80`

// Remote URLs only. No images are copied to the repository or served from local assets.
export const activityImages = [
  '1501339847302-ac426a4a7cbb', '1552674605-db6ffd4facb5', '1785449742068-6b329a8874cd',
  '1517245386807-bb43f82c33c4', '1610890716171-6b1bb98ffd09', '1742311115947-e5023fd20eee',
  '1555939594-58d7cb561ad1', '1544367567-0f2fcb009e0b', '1507842217343-583bb7270b66',
  '1464895216333-d859b45bf394', '1532298229144-0ec0c57515c7', '1513364776144-60967b0f800f',
  '1497366754035-f200968a6e72', '1489599849927-2ee91cede3ba', '1753901821774-22a88913130f',
  '1602479185069-cf2cfc4c463f', '1516280440614-37939bbacd81', '1414235077428-338989a2e8c0',
  '1542751371-adc38448a05e', '1514933651103-005eec06c04b',
].map(photo)

const people = [
  ['Mai Anh', 'female', '1999-05-14', 'Quận 1', 'Thiết kế sản phẩm', ['Cà phê', 'Nghệ thuật'], 'women/44'],
  ['Hoàng Nam', 'male', '1996-08-22', 'Bình Thạnh', 'Kỹ sư phần mềm', ['Chạy bộ', 'Gaming'], 'men/32'],
  ['Thu Hà', 'female', '2000-03-09', 'Phú Nhuận', 'Marketing', ['Yoga', 'Du lịch'], 'women/65'],
  ['Đức Huy', 'male', '1997-11-18', 'TP. Thủ Đức', 'Nhiếp ảnh gia', ['Nhiếp ảnh', 'Cầu lông'], 'men/11'],
  ['Ngọc Trâm', 'female', '1998-07-03', 'Quận 3', 'Giáo viên tiếng Anh', ['Học tập', 'Cà phê'], 'women/68'],
  ['Gia Bảo', 'male', '2001-01-26', 'Quận 7', 'Sinh viên cao học', ['Board game', 'Gaming'], 'men/75'],
  ['Khánh Linh', 'female', '1995-12-08', 'Tân Bình', 'Chuyên viên nhân sự', ['Du lịch', 'Ẩm thực'], 'women/26'],
  ['Minh Quân', 'male', '1994-06-17', 'Quận 10', 'Huấn luyện viên thể thao', ['Chạy bộ', 'Cầu lông'], 'men/46'],
  ['Bảo Ngân', 'female', '2000-10-12', 'Gò Vấp', 'Biên tập viên', ['Học tập', 'Âm nhạc'], 'women/17'],
  ['An Nhiên', 'other', '1998-04-05', 'Quận 4', 'Nghệ sĩ minh họa', ['Nghệ thuật', 'Nhiếp ảnh'], 'women/49'],
]

export const demoMembers = people.map(([name, gender, birthDate, district, occupation, interests, portrait], index) => ({
  id: `00000000-0000-4000-8000-${String(101 + index).padStart(12, '0')}`,
  email: `member${index + 1}@gomate.local`, username: `demo_member_${index + 1}`, name, gender, birthDate,
  location: `${district}, TP. Hồ Chí Minh`, occupation,
  bio: `${occupation}, sống tại ${district}. Mình thích ${interests.join(', ').toLowerCase()} và kết nối với những người bạn mới. Đây là hồ sơ demo hư cấu.`,
  interests, languages: index === 4 || index === 9 ? ['Tiếng Việt', 'English', '日本語'] : ['Tiếng Việt', 'English'],
  religion: index % 3 === 0 ? 'buddhist' : 'none', alcohol: index % 3 === 1 ? 'no' : 'yes',
  avatar_url: `https://randomuser.me/api/portraits/${portrait}.jpg`,
  cover_url: photo(index % 2 ? '1742311115947-e5023fd20eee' : '1602479185069-cf2cfc4c463f'),
  media_source: { avatar: 'https://randomuser.me/photos', cover: 'https://unsplash.com' },
}))

export const legacyDemoPortraits = ['women/75', 'women/47', 'men/51', 'women/54'].map(path => `https://randomuser.me/api/portraits/${path}.jpg`)

export const demoMediaSources = [
  'https://unsplash.com/photos/badminton-rackets-and-shuttlecock-on-red-court-with-sunlight-WI1rcfuoSTU',
  'https://unsplash.com/photos/picnic-basket-on-table-xBFEhnAMlFI',
  'https://unsplash.com/photos/pickleball-paddle-and-ball-rest-on-the-court-zpy9Lh5aRgg',
  'https://unsplash.com/photos/city-skyline-view-with-river-and-bridge-TJvH2nqycvE',
  'https://unsplash.com/photos/city-skyline-during-day-time-In5ENUxUrO8',
  'https://randomuser.me/photos',
]
